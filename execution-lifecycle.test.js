import test from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData } from "viem";
import { ExecutionLifecycle, ExecutionLifecycleError } from "./execution-lifecycle.js";
import { ExecutionJournal } from "./execution-journal.js";
import { NonceLane } from "./nonce-lane.js";
import { V2_ROUTER_ABI } from "./router-calldata.js";
import { DailySpendLedger } from "./spend-ledger.js";

const wallet = "0x1111111111111111111111111111111111111111";
const router = "0x2222222222222222222222222222222222222222";
const weth = "0x3333333333333333333333333333333333333333";
const token = "0x4444444444444444444444444444444444444444";
const now = 1_000_000;
const data = encodeFunctionData({
  abi: V2_ROUTER_ABI, functionName: "swapExactETHForTokens",
  args: [90n, [weth, token], wallet, BigInt(Math.floor(now / 1000) + 30)],
});
const rawIntent = {
  id: "entry:1", purpose: "micro-entry", chainId: 4663, from: wallet, to: router,
  valueWei: "100", data, expiresAt: now + 30_000,
  spendAsset: "native", spendAmount: "100",
};
const policy = {
  walletAddress: wallet, allowedChainIds: [4663],
  allowedCalls: { [router]: [data.slice(0, 10)] }, allowedPaths: [[weth, token]],
  maxValueWei: "200", spendLimits: { native: { maxPerTransaction: "200", maxDaily: "500" } },
  maxExpiryMs: 60_000,
  maxRouterDeadlineSeconds: 60,
};
const signedPayload = `0x${"ab".repeat(100)}`;
const { keccak256 } = await import("viem");
const hash = keccak256(signedPayload);
const preflight = async () => ({ approved: true, failures: [] });

function provider(overrides = {}) {
  return {
    calls: [],
    async getPendingNonce() { this.calls.push(["nonce"]); return 7; },
    async sign(intent, options) { this.calls.push(["sign", intent.id, options.nonce]); return {
      payload: signedPayload, transactionHash: hash, gas: "100000", maxFeePerGas: "2",
      maxPriorityFeePerGas: "1" }; },
    async broadcast(signed) { this.calls.push(["broadcast", signed]); return hash; },
    async waitForReceipt(txHash) { this.calls.push(["receipt", txHash]); return { status: "success" }; },
    async getReceipt(txHash) { this.calls.push(["getReceipt", txHash]); return null; },
    ...overrides,
  };
}

test("runs an approved intent through sign, broadcast, and confirmation", async () => {
  const walletProvider = provider();
  const ledger = new DailySpendLedger();
  const lifecycle = new ExecutionLifecycle({ policy, ledger, journal: new ExecutionJournal(),
    nonceLane: new NonceLane(), provider: walletProvider, preflight });
  const result = await lifecycle.submit(rawIntent, { now });
  assert.equal(result.status, "confirmed");
  assert.equal(result.transactionHash, hash);
  assert.deepEqual(walletProvider.calls.map(([name]) => name), ["nonce", "sign", "broadcast", "receipt"]);
  assert.equal(ledger.snapshot(now).spent.native, "100");
});

test("rejects unsafe calldata before reserving spend or calling the provider", async () => {
  const walletProvider = provider();
  const ledger = new DailySpendLedger();
  const lifecycle = new ExecutionLifecycle({ policy, ledger, journal: new ExecutionJournal(),
    nonceLane: new NonceLane(), provider: walletProvider, preflight });
  const result = await lifecycle.submit({ ...rawIntent, data: "0x12345678" }, { now });
  assert.equal(result.status, "rejected");
  assert.equal(walletProvider.calls.length, 0);
  assert.deepEqual(ledger.snapshot(now).spent, {});
});

test("rejects replay before calling the provider a second time", async () => {
  const walletProvider = provider();
  const ledger = new DailySpendLedger();
  const lifecycle = new ExecutionLifecycle({ policy, ledger, journal: new ExecutionJournal(),
    nonceLane: new NonceLane(), provider: walletProvider, preflight });
  await lifecycle.submit(rawIntent, { now });
  const replay = await lifecycle.submit(rawIntent, { now });
  assert.deepEqual(replay.failures, ["duplicate-intent"]);
  assert.equal(walletProvider.calls.filter(([name]) => name === "sign").length, 1);
});

test("retains the conservative reservation when broadcast fails", async () => {
  const walletProvider = provider({ async broadcast() { throw new Error("network-down"); } });
  const ledger = new DailySpendLedger();
  const lifecycle = new ExecutionLifecycle({ policy, ledger, journal: new ExecutionJournal(),
    nonceLane: new NonceLane(), provider: walletProvider, preflight });
  await assert.rejects(
    lifecycle.submit(rawIntent, { now }),
    (error) => error instanceof ExecutionLifecycleError && error.stage === "broadcasting",
  );
  assert.equal(ledger.snapshot(now).spent.native, "100");
});

test("reports a mined revert without treating it as confirmation", async () => {
  const lifecycle = new ExecutionLifecycle({
    policy, preflight, ledger: new DailySpendLedger(), journal: new ExecutionJournal(),
    nonceLane: new NonceLane(),
    provider: provider({ async waitForReceipt() { return { status: "reverted" }; } }),
  });
  assert.equal((await lifecycle.submit(rawIntent, { now })).status, "reverted");
});

test("persists a transaction hash before broadcast", async () => {
  const transitions = [];
  const journal = new ExecutionJournal({}, {
    persist: async (state) => transitions.push(state.records.at(-1)?.status),
  });
  const lifecycle = new ExecutionLifecycle({
    policy, preflight, ledger: new DailySpendLedger(), journal,
    nonceLane: new NonceLane(),
    provider: provider({ async broadcast() { throw new Error("network-down"); } }),
  });
  await assert.rejects(lifecycle.submit(rawIntent, { now }));
  assert.deepEqual(transitions, ["reserved", "nonce-reserved", "signed"]);
  assert.equal(journal.get(rawIntent.id).transactionHash, hash);
  assert.equal(journal.get(rawIntent.id).signedPayload, signedPayload);
  assert.equal(journal.get(rawIntent.id).gas, "100000");
});

test("journals reservation before spend and finalizes a failed spend as rejected", async () => {
  const order = [];
  const journal = new ExecutionJournal({}, { persist: async (_state, event) => {
    order.push(`${event.type}:${event.record.status}`);
  } });
  const ledger = new DailySpendLedger({}, { persist: async (_state, event) => {
    order.push(event.type);
    throw new Error("state-write-failed");
  } });
  const walletProvider = provider();
  const lifecycle = new ExecutionLifecycle({ policy, preflight, ledger, journal,
    nonceLane: new NonceLane(), provider: walletProvider });
  const result = await lifecycle.submit(rawIntent, { now });
  assert.deepEqual(result, { status: "rejected", stage: "reservation",
    failures: ["execution-spend-persistence-failed"] });
  assert.deepEqual(order, ["execution-transition:reserved", "execution-spend-recorded",
    "execution-transition:rejected"]);
  assert.equal(journal.get(rawIntent.id).status, "rejected");
  assert.deepEqual(journal.pending(), []);
  assert.deepEqual(ledger.snapshot(now).spent, {});
  assert.deepEqual(walletProvider.calls, []);
});

test("keeps a durable reservation pending if spend and rejection persistence both fail", async () => {
  let journalWrites = 0;
  const journal = new ExecutionJournal({}, { persist: async () => {
    journalWrites += 1;
    if (journalWrites > 1) throw new Error("checkpoint-unavailable");
  } });
  const ledger = new DailySpendLedger({}, {
    persist: async () => { throw new Error("state-write-failed"); },
  });
  const walletProvider = provider();
  const lifecycle = new ExecutionLifecycle({ policy, preflight, ledger, journal,
    nonceLane: new NonceLane(), provider: walletProvider });
  const result = await lifecycle.submit(rawIntent, { now });
  assert.deepEqual(result.failures, ["execution-spend-persistence-failed",
    "execution-rejection-persistence-failed"]);
  assert.equal(journal.get(rawIntent.id).status, "reserved");
  assert.equal(journal.pending().length, 1);
  assert.deepEqual(ledger.snapshot(now).spent, {});
  assert.deepEqual(walletProvider.calls, []);
});

test("reconciles a pending transaction after restart without signing or broadcasting", async () => {
  const journal = new ExecutionJournal({ records: [{
    intentId: rawIntent.id, status: "broadcast", transactionHash: hash, createdAt: now, updatedAt: now,
  }] });
  const walletProvider = provider({ async getReceipt() { return { status: "success", blockNumber: 12 }; } });
  const lifecycle = new ExecutionLifecycle({
    policy, preflight, ledger: new DailySpendLedger(), journal, nonceLane: new NonceLane({ lanes: [{
      key: `4663:${wallet}`, chainId: 4663, walletAddress: wallet, nextNonce: 8,
      pending: { intentId: rawIntent.id, nonce: 7 },
    }] }), provider: walletProvider,
  });
  const [result] = await lifecycle.recoverPending({ now: now + 1 });
  assert.equal(result.recovery, "reconciled");
  assert.equal(journal.get(rawIntent.id).status, "confirmed");
  assert.equal(walletProvider.calls.length, 0);
});

test("never rebroadcasts when recovery cannot find a receipt", async () => {
  const journal = new ExecutionJournal({ records: [{
    intentId: rawIntent.id, status: "signed", transactionHash: hash, createdAt: now, updatedAt: now,
  }] });
  const walletProvider = provider();
  const lifecycle = new ExecutionLifecycle({
    policy, preflight, ledger: new DailySpendLedger(), journal,
    nonceLane: new NonceLane(), provider: walletProvider,
  });
  const [result] = await lifecycle.recoverPending({ now: now + 1 });
  assert.equal(result.recovery, "still-pending");
  assert.deepEqual(walletProvider.calls.map(([name]) => name), ["getReceipt"]);
});

test("escalates an old missing receipt to manual review", async () => {
  const journal = new ExecutionJournal({ records: [{
    intentId: rawIntent.id, status: "broadcast", transactionHash: hash,
    createdAt: now, updatedAt: now,
  }] });
  const lifecycle = new ExecutionLifecycle({
    policy, preflight, ledger: new DailySpendLedger(), journal,
    nonceLane: new NonceLane(), provider: provider(),
  });
  const [result] = await lifecycle.recoverPending({ now: now + 11 * 60_000 });
  assert.equal(result.recovery, "manual-review");
});

test("operator recovery can broadcast only the identical persisted signed bytes", async () => {
  const journal = new ExecutionJournal({ records: [{
    intentId: rawIntent.id, status: "signed", transactionHash: hash,
    signedPayload, createdAt: now, updatedAt: now,
  }] });
  const walletProvider = provider();
  const lifecycle = new ExecutionLifecycle({
    policy, preflight, ledger: new DailySpendLedger(), journal, nonceLane: new NonceLane(),
    provider: walletProvider,
  });
  const result = await lifecycle.rebroadcastIdentical(rawIntent.id, { now: now + 1 });
  assert.equal(result.transactionHash, hash);
  assert.equal(journal.get(rawIntent.id).status, "broadcast");
  assert.deepEqual(walletProvider.calls.map(([name]) => name), ["broadcast"]);
});

test("a dropped broadcast can rebroadcast only the identical persisted bytes", async () => {
  const calls = [];
  const journal = new ExecutionJournal();
  const lifecycle = new ExecutionLifecycle({
    policy, preflight, ledger: new DailySpendLedger(), journal, nonceLane: new NonceLane(),
    provider: {
      getPendingNonce: async () => 7,
      sign: async () => ({ payload: signedPayload, transactionHash: hash }),
      broadcast: async (bytes) => { calls.push(bytes); return hash; },
      waitForReceipt: async () => { throw new Error("transaction-receipt-timeout"); },
      getReceipt: async () => null,
    },
  });
  await assert.rejects(lifecycle.submit(rawIntent, { now }), /execution-confirming-failed/);
  assert.equal(journal.get(rawIntent.id).status, "broadcast");
  const result = await lifecycle.rebroadcastIdentical(rawIntent.id);
  assert.equal(result.status, "broadcast");
  assert.deepEqual(calls, [signedPayload, signedPayload]);
});

test("per-intent preflight can fail closed before spend or provider access", async () => {
  const walletProvider = provider();
  const ledger = new DailySpendLedger();
  const journal = new ExecutionJournal();
  const lifecycle = new ExecutionLifecycle({ policy, ledger, journal,
    nonceLane: new NonceLane(), provider: walletProvider,
    preflight: async () => ({ approved: false, failures: ["policy-revalidation-failed"] }) });
  const result = await lifecycle.submit(rawIntent, { now });
  assert.deepEqual(result, { status: "rejected", stage: "preflight",
    failures: ["policy-revalidation-failed"] });
  assert.deepEqual(ledger.snapshot(now).spent, {});
  assert.deepEqual(walletProvider.calls, []);
  assert.deepEqual(journal.get(rawIntent.id).failures, ["policy-revalidation-failed"]);
  assert.deepEqual(journal.pending(), []);
});
