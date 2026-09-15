import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EvidenceJournal } from "./evidence-journal.js";
import { loadJsonState, saveJsonState } from "./state-store.js";
import { runExecutionRecovery } from "./recover-executions.js";

const wallet = "0x1111111111111111111111111111111111111111";
const hash = `0x${"12".repeat(32)}`;

async function durableFixture() {
  const dir = await mkdtemp(join(tmpdir(), "atlas-execution-recovery-"));
  const statePath = join(dir, "state.json");
  const evidenceDir = join(dir, "evidence");
  const evidence = new EvidenceJournal(join(evidenceDir, "test-epoch.jsonl"));
  await evidence.initialize();
  await evidence.append({ type: "execution-transition", intentId: "entry:1" });
  await evidence.append({ type: "execution-spend-recorded", intentId: "entry:1" });
  await evidence.append({ type: "execution-nonce-reserved", intentId: "entry:1" });
  await saveJsonState(statePath, {
    cursor: 100, paperStrategyVersion: "test-epoch", paperBooks: {},
    execution: {
      journal: { transitionCount: 1, records: [{ intentId: "entry:1",
        status: "broadcast", transactionHash: hash, chainId: 4663,
        createdAt: 1, updatedAt: 1 }] },
      spendLedger: { mutationCount: 1, day: "2026-09-15", spent: { weth: "10" },
        intentIds: ["entry:1"] },
      nonceLane: { mutationCount: 1, lanes: [{ key: `4663:${wallet}`,
        chainId: 4663, walletAddress: wallet, nextNonce: 8,
        pending: { intentId: "entry:1", nonce: 7 } }] },
    },
    evidenceSequence: evidence.snapshot().sequence,
    evidenceLastHash: evidence.snapshot().lastHash,
  });
  return { dir, statePath, evidenceDir };
}

const rpcFetch = async (_url, request) => {
  const { id, method, params } = JSON.parse(request.body);
  const result = method === "eth_chainId" ? "0x1237" : {
    status: "0x1", transactionHash: params[0], blockNumber: "0x64",
  };
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200, headers: { "content-type": "application/json" },
  });
};

test("isolated command reconciles receipt through evidence and atomic state", async () => {
  const fixture = await durableFixture();
  try {
    const report = await runExecutionRecovery({
      env: { STATE_FILE: fixture.statePath, EVIDENCE_DIR: fixture.evidenceDir,
        RPC_URL: "https://rpc.invalid", EXECUTION_RECOVERY_CONFIRM:
          "RECONCILE_ATLAS_EXECUTIONS_OFFLINE", EXECUTION_RECOVERY_MIN_STATE_AGE_MS: "0" },
      fetchImpl: rpcFetch, now: Date.now() + 1_000,
    });
    assert.equal(report.counts.reconciled, 1);
    assert.equal(report.pendingExecutions, 0);
    const state = await loadJsonState(fixture.statePath);
    assert.equal(state.execution.journal.records[0].status, "confirmed");
    assert.equal(state.execution.nonceLane.lanes[0].pending, null);
    assert.equal(state.execution.journal.transitionCount, 2);
    assert.equal(state.execution.nonceLane.mutationCount, 2);
    const evidenceLines = (await readFile(
      join(fixture.evidenceDir, "test-epoch.jsonl"), "utf8")).trim().split("\n");
    assert.equal(evidenceLines.length, 5);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("isolated command refuses to run without an offline operator assertion", async () => {
  await assert.rejects(runExecutionRecovery({ env: {} }),
    /execution-recovery-offline-confirmation-required/);
});

test("isolated command rejects private material and a recently written state", async () => {
  await assert.rejects(runExecutionRecovery({ env: {
    EXECUTION_RECOVERY_CONFIRM: "RECONCILE_ATLAS_EXECUTIONS_OFFLINE",
    TURNKEY_SIGNING_API_PRIVATE_KEY: "forbidden",
  } }), /execution-recovery-private-material-forbidden/);
  const fixture = await durableFixture();
  try {
    await assert.rejects(runExecutionRecovery({
      env: { STATE_FILE: fixture.statePath, EVIDENCE_DIR: fixture.evidenceDir,
        EXECUTION_RECOVERY_CONFIRM: "RECONCILE_ATLAS_EXECUTIONS_OFFLINE" },
      now: Date.now(),
    }), /execution-runtime-may-still-be-running/);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("chain mismatch fails before mutation and releases the exclusive lock", async () => {
  const fixture = await durableFixture();
  const wrongChainFetch = async (_url, request) => {
    const { id } = JSON.parse(request.body);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: "0x1" }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  try {
    await assert.rejects(runExecutionRecovery({
      env: { STATE_FILE: fixture.statePath, EVIDENCE_DIR: fixture.evidenceDir,
        RPC_URL: "https://rpc.invalid", EXECUTION_RECOVERY_CONFIRM:
          "RECONCILE_ATLAS_EXECUTIONS_OFFLINE", EXECUTION_RECOVERY_MIN_STATE_AGE_MS: "0" },
      fetchImpl: wrongChainFetch, now: Date.now() + 1_000,
    }), /execution-recovery-chain-mismatch/);
    await assert.rejects(access(`${fixture.statePath}.execution-recovery.lock`));
    const state = await loadJsonState(fixture.statePath);
    assert.equal(state.execution.journal.records[0].status, "broadcast");
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("a checkpoint change during receipt reads blocks every recovery write", async () => {
  const fixture = await durableFixture();
  const concurrentFetch = async (_url, request) => {
    const { id, method, params } = JSON.parse(request.body);
    if (method === "eth_chainId") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: "0x1237" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
    const concurrentState = await loadJsonState(fixture.statePath);
    concurrentState.concurrentWriterMarker = true;
    await saveJsonState(fixture.statePath, concurrentState);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: {
      status: "0x1", transactionHash: params[0], blockNumber: "0x64",
    } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await assert.rejects(runExecutionRecovery({
      env: { STATE_FILE: fixture.statePath, EVIDENCE_DIR: fixture.evidenceDir,
        RPC_URL: "https://rpc.invalid", EXECUTION_RECOVERY_CONFIRM:
          "RECONCILE_ATLAS_EXECUTIONS_OFFLINE", EXECUTION_RECOVERY_MIN_STATE_AGE_MS: "0" },
      fetchImpl: concurrentFetch, now: Date.now() + 1_000,
    }), /execution-recovery-concurrent-runtime-detected/);
    const state = await loadJsonState(fixture.statePath);
    assert.equal(state.concurrentWriterMarker, true);
    assert.equal(state.execution.journal.records[0].status, "broadcast");
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});
