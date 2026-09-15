import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EvidenceJournal } from "./evidence-journal.js";
import { loadJsonState, saveJsonState } from "./state-store.js";
import { runExecutionRecovery } from "./recover-executions.js";
import { keccak256, serializeTransaction } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { executionIntentTransactionDigest } from "./execution-transaction-digest.js";

const wallet = "0x1111111111111111111111111111111111111111";
const hash = `0x${"12".repeat(32)}`;
const signingAccount = privateKeyToAccount(`0x${"11".repeat(32)}`);
const organizationId = "11111111-1111-7111-8111-111111111111";
const observerUserId = "33333333-3333-7333-8333-333333333333";
const signingUserId = "44444444-4444-7444-8444-444444444444";

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

async function neverSignedFixture() {
  const fixture = await durableFixture();
  const state = await loadJsonState(fixture.statePath);
  state.execution.journal.records[0].status = "manual-review";
  state.execution.journal.records[0].signingProtocolVersion = 2;
  state.execution.journal.records[0].transactionHash = null;
  state.execution.journal.records[0].recoveryFailure = "signed-transaction-not-durable";
  await saveJsonState(fixture.statePath, state);
  return fixture;
}

async function ambiguousSigningFixture(signingRequestedAt) {
  const fixture = await durableFixture();
  const state = await loadJsonState(fixture.statePath);
  const transaction = { chainId: 4663, type: "eip1559", nonce: 7,
    to: "0x2222222222222222222222222222222222222222", data: "0x12345678",
    value: 0n, gas: 150000n, maxFeePerGas: 1000000000n,
    maxPriorityFeePerGas: 1000000n };
  Object.assign(state.execution.journal.records[0], { status: "manual-review",
    signingProtocolVersion: 3, transactionHash: null,
    recoveryFailure: "manual-review-signing-ambiguous", signingRequestedAt,
    nonce: 7, intentTransactionDigest: executionIntentTransactionDigest({ ...transaction,
      from: signingAccount.address }) });
  state.execution.nonceLane.lanes[0].walletAddress = signingAccount.address.toLowerCase();
  state.execution.nonceLane.lanes[0].key = `4663:${signingAccount.address.toLowerCase()}`;
  await saveJsonState(fixture.statePath, state);
  const signedTransaction = await signingAccount.signTransaction(transaction);
  const activity = { id: "activity-exact", organizationId,
    status: "ACTIVITY_STATUS_COMPLETED", type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
    createdAt: { seconds: String(Math.floor((signingRequestedAt + 1000) / 1000)), nanos: "0" },
    votes: [{ userId: signingUserId, selection: "VOTE_SELECTION_APPROVED" }],
    intent: { signTransactionIntentV2: { signWith: signingAccount.address,
      unsignedTransaction: serializeTransaction(transaction) } },
    result: { signTransactionResult: { signedTransaction } } };
  return { ...fixture, activity, signedTransaction };
}

const rpcFetch = async (_url, request) => {
  const { id, method, params } = JSON.parse(request.body);
  const result = method === "eth_chainId" ? "0x1237" : {
    status: "0x1", transactionHash: params[0], from: wallet, blockNumber: "0x64",
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
        TURNKEY_WALLET_ADDRESS: wallet,
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

test("isolated command cannot resolve a label first created in the same run", async () => {
  const fixture = await durableFixture();
  const state = await loadJsonState(fixture.statePath);
  state.execution.journal.records[0].status = "reserved";
  state.execution.journal.records[0].transactionHash = null;
  await saveJsonState(fixture.statePath, state);
  const noReceiptFetch = async (_url, request) => {
    const { id, method } = JSON.parse(request.body);
    if (method !== "eth_chainId") throw new Error("receipt-read-not-expected");
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: "0x1237" }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  try {
    await assert.rejects(runExecutionRecovery({
      env: { STATE_FILE: fixture.statePath, EVIDENCE_DIR: fixture.evidenceDir,
        TURNKEY_WALLET_ADDRESS: wallet, RPC_URL: "https://rpc.invalid",
        EXECUTION_RECOVERY_CONFIRM: "RECONCILE_ATLAS_EXECUTIONS_OFFLINE",
        EXECUTION_RECOVERY_MIN_STATE_AGE_MS: "0",
        EXECUTION_MANUAL_REVIEW_INTENT_ID: "entry:1",
        EXECUTION_MANUAL_REVIEW_CONFIRM: "REJECT_ATLAS_NEVER_SIGNED_RESERVATION" },
      fetchImpl: noReceiptFetch, now: Date.now() + 1_000,
    }), /manual-review-label-not-yet-durable/);
    const restored = await loadJsonState(fixture.statePath);
    assert.equal(restored.execution.journal.records[0].status, "manual-review");
    assert.notEqual(restored.execution.nonceLane.lanes[0].pending, null);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("isolated command refuses to run without an offline operator assertion", async () => {
  await assert.rejects(runExecutionRecovery({ env: {} }),
    /execution-recovery-offline-confirmation-required/);
});

test("isolated command durably rejects a proven never-signed manual review", async () => {
  const fixture = await neverSignedFixture();
  const noReceiptFetch = async (_url, request) => {
    const { id, method } = JSON.parse(request.body);
    if (method !== "eth_chainId") throw new Error("receipt-read-not-expected");
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: "0x1237" }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  try {
    const report = await runExecutionRecovery({
      env: { STATE_FILE: fixture.statePath, EVIDENCE_DIR: fixture.evidenceDir,
        TURNKEY_WALLET_ADDRESS: wallet, RPC_URL: "https://rpc.invalid",
        EXECUTION_RECOVERY_CONFIRM: "RECONCILE_ATLAS_EXECUTIONS_OFFLINE",
        EXECUTION_RECOVERY_MIN_STATE_AGE_MS: "0",
        EXECUTION_MANUAL_REVIEW_INTENT_ID: "entry:1",
        EXECUTION_MANUAL_REVIEW_CONFIRM: "REJECT_ATLAS_NEVER_SIGNED_RESERVATION" },
      fetchImpl: noReceiptFetch, now: Date.now() + 1_000,
    });
    assert.equal(report.operatorResolution.status, "operator-rejected");
    assert.equal(report.pendingExecutions, 0);
    const state = await loadJsonState(fixture.statePath);
    assert.equal(state.execution.journal.records[0].status, "operator-rejected");
    assert.equal(state.execution.nonceLane.lanes[0].pending, null);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("isolated command lists, re-fetches, and restores one exact Turnkey activity", async () => {
  const signingRequestedAt = Date.now() - 120_000;
  const fixture = await ambiguousSigningFixture(signingRequestedAt);
  const calls = [];
  const apiPublicKey = `02${"12".repeat(32)}`;
  const client = {
    async getWhoami() { return { userId: observerUserId }; },
    async getOrganizationConfigs() { return { configs: { quorum: { userIds: [] } } }; },
    async getPolicies() { return { policies: [{ policyId: organizationId,
      effect: "EFFECT_DENY", consensus: `approvers.any(user, user.id == '${observerUserId}')` }] }; },
    async getUser() { return { user: { apiKeys: [{ credential: { publicKey: apiPublicKey } }],
      userTags: [] } }; },
    async getActivities(request) { calls.push(["list", request]); return { activities: [fixture.activity] }; },
    async getActivity(request) { calls.push(["get", request]); return { activity: fixture.activity }; },
  };
  const noReceiptFetch = async (_url, request) => {
    const { id, method } = JSON.parse(request.body);
    if (method !== "eth_chainId") throw new Error("receipt-read-not-expected");
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: "0x1237" }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  try {
    const report = await runExecutionRecovery({ env: {
      STATE_FILE: fixture.statePath, EVIDENCE_DIR: fixture.evidenceDir,
      TURNKEY_WALLET_ADDRESS: signingAccount.address, RPC_URL: "https://rpc.invalid",
      EXECUTION_RECOVERY_CONFIRM: "RECONCILE_ATLAS_EXECUTIONS_OFFLINE",
      EXECUTION_RECOVERY_MIN_STATE_AGE_MS: "0", EXECUTION_MANUAL_REVIEW_INTENT_ID: "entry:1",
      EXECUTION_MANUAL_REVIEW_CONFIRM: "RESTORE_ATLAS_SIGNED_TRANSACTION_FROM_TURNKEY",
      TURNKEY_ORGANIZATION_ID: organizationId, TURNKEY_WALLET_ID: organizationId,
      TURNKEY_API_PUBLIC_KEY: apiPublicKey, TURNKEY_API_PRIVATE_KEY: "observer-private",
      TURNKEY_POLICY_ID: organizationId, TURNKEY_READ_ONLY_ATTESTED: "true",
      TURNKEY_SIGNING_USER_ID: signingUserId, MICRO_MAINNET_MAX_GAS: "200000",
      MICRO_MAINNET_MAX_FEE_PER_GAS_WEI: "2000000000",
      TURNKEY_ACTIVITY_MAX_PAGES: "10",
    }, fetchImpl: noReceiptFetch, now: Date.now(), makeTurnkeyClient: () => client });
    assert.equal(report.operatorResolution.status, "signed");
    assert.equal(report.operatorResolution.activityId, "activity-exact");
    assert.equal(report.operatorResolution.scannedActivityCount, 1);
    assert.deepEqual(calls.map(([kind]) => kind), ["list", "get"]);
    const state = await loadJsonState(fixture.statePath);
    assert.equal(state.execution.journal.records[0].signedPayload, fixture.signedTransaction);
    assert.equal(state.execution.journal.records[0].recoveryFailure, null);
    assert.equal(state.execution.journal.records[0].operatorResolution.activityId,
      "activity-exact");
    assert.notEqual(state.execution.nonceLane.lanes[0].pending, null);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("isolated command checkpoints and rebroadcasts only the journaled payload", async () => {
  const fixture = await durableFixture();
  const transaction = { chainId: 4663, type: "eip1559", nonce: 7,
    to: "0x2222222222222222222222222222222222222222", data: "0x12345678",
    value: 0n, gas: 150000n, maxFeePerGas: 1000000000n,
    maxPriorityFeePerGas: 1000000n };
  const signedPayload = await signingAccount.signTransaction(transaction);
  const transactionHash = keccak256(signedPayload);
  const state = await loadJsonState(fixture.statePath);
  Object.assign(state.execution.journal.records[0], { status: "signed", nonce: 7,
    signedPayload, transactionHash, updatedAt: Date.now() });
  state.execution.nonceLane.lanes[0].walletAddress = signingAccount.address.toLowerCase();
  state.execution.nonceLane.lanes[0].key = `4663:${signingAccount.address.toLowerCase()}`;
  await saveJsonState(fixture.statePath, state);
  const methods = [];
  const rebroadcastFetch = async (_url, request) => {
    const { id, method, params } = JSON.parse(request.body);
    methods.push(method);
    let result;
    if (method === "eth_chainId") result = "0x1237";
    else if (method === "eth_getTransactionReceipt") result = null;
    else if (method === "eth_getTransactionCount") result = "0x7";
    else if (method === "eth_sendRawTransaction") {
      assert.equal(params[0], signedPayload);
      result = transactionHash;
    } else throw new Error(`unexpected-method:${method}`);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  try {
    const report = await runExecutionRecovery({ env: {
      STATE_FILE: fixture.statePath, EVIDENCE_DIR: fixture.evidenceDir,
      TURNKEY_WALLET_ADDRESS: signingAccount.address, RPC_URL: "https://rpc.invalid",
      EXECUTION_RECOVERY_CONFIRM: "RECONCILE_ATLAS_EXECUTIONS_OFFLINE",
      EXECUTION_RECOVERY_MIN_STATE_AGE_MS: "0", EXECUTION_MANUAL_REVIEW_INTENT_ID: "entry:1",
      EXECUTION_MANUAL_REVIEW_CONFIRM: "REBROADCAST_ATLAS_IDENTICAL_SIGNED_PAYLOAD",
    }, fetchImpl: rebroadcastFetch, now: Date.now() + 1 });
    assert.equal(report.operatorResolution.status, "broadcast");
    assert.equal(methods.filter((method) => method === "eth_sendRawTransaction").length, 1);
    assert.ok(report.postBroadcastRecovery);
    const restored = await loadJsonState(fixture.statePath);
    assert.equal(restored.execution.journal.records[0].status, "broadcast");
    assert.equal(restored.execution.journal.records[0].operatorResolution.transactionHash,
      transactionHash);
    assert.notEqual(restored.execution.nonceLane.lanes[0].pending, null);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
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
        TURNKEY_WALLET_ADDRESS: wallet,
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
        TURNKEY_WALLET_ADDRESS: wallet,
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
      status: "0x1", transactionHash: params[0], from: wallet, blockNumber: "0x64",
    } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await assert.rejects(runExecutionRecovery({
      env: { STATE_FILE: fixture.statePath, EVIDENCE_DIR: fixture.evidenceDir,
        TURNKEY_WALLET_ADDRESS: wallet,
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

test("an evidence append during receipt reads blocks recovery before its append", async () => {
  const fixture = await durableFixture();
  const concurrentFetch = async (_url, request) => {
    const { id, method, params } = JSON.parse(request.body);
    if (method === "eth_chainId") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: "0x1237" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    const concurrentEvidence = new EvidenceJournal(
      join(fixture.evidenceDir, "test-epoch.jsonl"),
    );
    await concurrentEvidence.initialize();
    await concurrentEvidence.append({ type: "concurrent-writer-test" });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: {
      status: "0x1", transactionHash: params[0], from: wallet, blockNumber: "0x64",
    } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await assert.rejects(runExecutionRecovery({
      env: { STATE_FILE: fixture.statePath, EVIDENCE_DIR: fixture.evidenceDir,
        TURNKEY_WALLET_ADDRESS: wallet,
        RPC_URL: "https://rpc.invalid", EXECUTION_RECOVERY_CONFIRM:
          "RECONCILE_ATLAS_EXECUTIONS_OFFLINE", EXECUTION_RECOVERY_MIN_STATE_AGE_MS: "0" },
      fetchImpl: concurrentFetch, now: Date.now() + 1_000,
    }), /execution-recovery-concurrent-runtime-detected/);
    const state = await loadJsonState(fixture.statePath);
    assert.equal(state.execution.journal.records[0].status, "broadcast");
    const lines = (await readFile(
      join(fixture.evidenceDir, "test-epoch.jsonl"), "utf8")).trim().split("\n");
    assert.equal(lines.length, 4);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});
