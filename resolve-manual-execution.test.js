import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EvidenceJournal } from "./evidence-journal.js";
import { loadJsonState, saveJsonState } from "./state-store.js";
import { runManualExecutionResolution } from "./resolve-manual-execution.js";
import { keccak256 } from "viem";

const wallet = "0x1111111111111111111111111111111111111111";
const intentId = "entry:1";
const payload = `0x${"ab".repeat(100)}`;
const hash = keccak256(payload);
const cancelHash = `0x${"34".repeat(32)}`;

async function unsignedFixture(record = {}) {
  const dir = await mkdtemp(join(tmpdir(), "atlas-manual-resolution-"));
  const statePath = join(dir, "state.json");
  const evidenceDir = join(dir, "evidence");
  const evidence = new EvidenceJournal(join(evidenceDir, "test-epoch.jsonl"));
  await evidence.initialize();
  for (let index = 0; index < 3; index += 1) {
    await evidence.append({ type: "execution-transition", intentId });
  }
  await evidence.append({ type: "execution-spend-recorded", intentId });
  await evidence.append({ type: "execution-nonce-reserved", intentId });
  await saveJsonState(statePath, {
    cursor: 100, paperStrategyVersion: "test-epoch", paperBooks: {},
    execution: {
      journal: { transitionCount: 3, records: [{ intentId,
        status: "manual-review", recoveryFailure: "signed-transaction-not-durable",
        chainId: 4663, createdAt: 1, updatedAt: 2, ...record }] },
      spendLedger: { mutationCount: 1, day: "2026-09-15", spent: { weth: "10" },
        intentIds: [intentId] },
      nonceLane: { mutationCount: 1, lanes: [{ key: `4663:${wallet}`,
        chainId: 4663, walletAddress: wallet, nextNonce: 8,
        pending: { intentId, nonce: 7 } }] },
    },
    evidenceSequence: evidence.snapshot().sequence,
    evidenceLastHash: evidence.snapshot().lastHash,
  });
  return { dir, statePath, evidenceDir };
}

const chainFetch = async (_url, request) => {
  const { id } = JSON.parse(request.body);
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: "0x1237" }), {
    status: 200, headers: { "content-type": "application/json" },
  });
};

const envFor = (fixture, confirmation) => ({
  STATE_FILE: fixture.statePath,
  EVIDENCE_DIR: fixture.evidenceDir,
  RPC_URL: "https://rpc.invalid",
  TURNKEY_WALLET_ADDRESS: wallet,
  EXECUTION_RECOVERY_MIN_STATE_AGE_MS: "0",
  EXECUTION_MANUAL_REVIEW_ACTION: "reject-unsigned",
  EXECUTION_MANUAL_REVIEW_INTENT_ID: intentId,
  EXECUTION_MANUAL_REVIEW_CONFIRM: confirmation,
});

test("one-shot unsigned resolution durably cancels and releases the lane", async () => {
  const fixture = await unsignedFixture();
  try {
    const report = await runManualExecutionResolution({
      env: envFor(fixture, `REJECT_UNSIGNED_ATLAS_EXECUTION:${intentId}`),
      fetchImpl: chainFetch, now: Date.now() + 1_000,
    });
    assert.equal(report.status, "cancelled");
    const state = await loadJsonState(fixture.statePath);
    assert.equal(state.execution.journal.records[0].status, "cancelled");
    assert.equal(state.execution.nonceLane.lanes[0].pending, null);
    assert.equal(state.execution.spendLedger.spent.weth, "10");
    const lines = (await readFile(
      join(fixture.evidenceDir, "test-epoch.jsonl"), "utf8")).trim().split("\n");
    assert.equal(lines.length, 7);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("wrong operator confirmation leaves durable state untouched", async () => {
  const fixture = await unsignedFixture();
  try {
    await assert.rejects(runManualExecutionResolution({
      env: envFor(fixture, "wrong"), fetchImpl: chainFetch, now: Date.now() + 1_000,
    }), /execution-manual-review-confirmation-mismatch/);
    const state = await loadJsonState(fixture.statePath);
    assert.equal(state.execution.journal.records[0].status, "manual-review");
    assert.notEqual(state.execution.nonceLane.lanes[0].pending, null);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("one-shot rebroadcast sends persisted bytes and leaves the nonce pending", async () => {
  const fixture = await unsignedFixture({ recoveryFailure: "execution-receipt-timeout",
    transactionHash: hash, signedPayload: payload });
  const calls = [];
  const fetchImpl = async (_url, request) => {
    const { id, method, params } = JSON.parse(request.body);
    calls.push([method, params]);
    const result = method === "eth_chainId" ? "0x1237" : hash;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  try {
    const report = await runManualExecutionResolution({ env: {
      ...envFor(fixture, `REBROADCAST_ATLAS_EXECUTION:${intentId}:${hash}`),
      EXECUTION_MANUAL_REVIEW_ACTION: "rebroadcast-identical",
    }, fetchImpl, now: Date.now() + 1_000 });
    assert.equal(report.status, "broadcast");
    assert.deepEqual(calls.map(([method]) => method), ["eth_chainId", "eth_sendRawTransaction"]);
    assert.equal(calls[1][1][0], payload);
    const state = await loadJsonState(fixture.statePath);
    assert.equal(state.execution.journal.records[0].status, "broadcast");
    assert.notEqual(state.execution.nonceLane.lanes[0].pending, null);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("one-shot nonce-cancel proof accepts only the mined self-cancel", async () => {
  const fixture = await unsignedFixture({ recoveryFailure: "execution-receipt-timeout",
    transactionHash: hash, signedPayload: payload });
  const fetchImpl = async (_url, request) => {
    const { id, method } = JSON.parse(request.body);
    const result = method === "eth_chainId" ? "0x1237"
      : method === "eth_getTransactionByHash" ? {
        hash: cancelHash, from: wallet, to: wallet, nonce: "0x7",
        value: "0x0", chainId: "0x1237", input: "0x",
      } : { transactionHash: cancelHash, from: wallet,
        status: "0x1", blockNumber: "0x64" };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  try {
    const report = await runManualExecutionResolution({ env: {
      ...envFor(fixture, `CONFIRM_ATLAS_NONCE_CANCEL:${intentId}:${cancelHash}`),
      EXECUTION_MANUAL_REVIEW_ACTION: "prove-nonce-cancel",
      EXECUTION_MANUAL_REVIEW_REPLACEMENT_TX_HASH: cancelHash,
    }, fetchImpl, now: Date.now() + 1_000 });
    assert.equal(report.status, "cancelled");
    const state = await loadJsonState(fixture.statePath);
    assert.equal(state.execution.journal.records[0].status, "cancelled");
    assert.equal(state.execution.journal.records[0].nonceConsumedByTransactionHash, cancelHash);
    assert.equal(state.execution.nonceLane.lanes[0].pending, null);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});
