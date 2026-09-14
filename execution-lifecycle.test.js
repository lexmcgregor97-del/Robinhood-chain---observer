import test from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData } from "viem";
import { ExecutionLifecycle, ExecutionLifecycleError } from "./execution-lifecycle.js";
import { ExecutionJournal } from "./execution-journal.js";
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
};
const policy = {
  walletAddress: wallet, allowedChainIds: [4663],
  allowedCalls: { [router]: [data.slice(0, 10)] }, allowedPaths: [[weth, token]],
  maxValueWei: "200", maxDailySpendWei: "500", maxExpiryMs: 60_000,
  maxRouterDeadlineSeconds: 60,
};
const hash = `0x${"ab".repeat(32)}`;

function provider(overrides = {}) {
  return {
    calls: [],
    async sign(intent) { this.calls.push(["sign", intent.id]); return { payload: "signed", transactionHash: hash }; },
    async broadcast(signed) { this.calls.push(["broadcast", signed]); return hash; },
    async waitForReceipt(txHash) { this.calls.push(["receipt", txHash]); return { status: "success" }; },
    async getReceipt(txHash) { this.calls.push(["getReceipt", txHash]); return null; },
    ...overrides,
  };
}

test("runs an approved intent through sign, broadcast, and confirmation", async () => {
  const walletProvider = provider();
  const ledger = new DailySpendLedger();
  const lifecycle = new ExecutionLifecycle({ policy, ledger, journal: new ExecutionJournal(), provider: walletProvider });
  const result = await lifecycle.submit(rawIntent, { now });
  assert.equal(result.status, "confirmed");
  assert.equal(result.transactionHash, hash);
  assert.deepEqual(walletProvider.calls.map(([name]) => name), ["sign", "broadcast", "receipt"]);
  assert.equal(ledger.snapshot(now).spentWei, "100");
});

test("rejects unsafe calldata before reserving spend or calling the provider", async () => {
  const walletProvider = provider();
  const ledger = new DailySpendLedger();
  const lifecycle = new ExecutionLifecycle({ policy, ledger, journal: new ExecutionJournal(), provider: walletProvider });
  const result = await lifecycle.submit({ ...rawIntent, data: "0x12345678" }, { now });
  assert.equal(result.status, "rejected");
  assert.equal(walletProvider.calls.length, 0);
  assert.equal(ledger.snapshot(now).spentWei, "0");
});

test("rejects replay before calling the provider a second time", async () => {
  const walletProvider = provider();
  const ledger = new DailySpendLedger();
  const lifecycle = new ExecutionLifecycle({ policy, ledger, journal: new ExecutionJournal(), provider: walletProvider });
  await lifecycle.submit(rawIntent, { now });
  const replay = await lifecycle.submit(rawIntent, { now });
  assert.deepEqual(replay.failures, ["duplicate-intent"]);
  assert.equal(walletProvider.calls.filter(([name]) => name === "sign").length, 1);
});

test("retains the conservative reservation when broadcast fails", async () => {
  const walletProvider = provider({ async broadcast() { throw new Error("network-down"); } });
  const ledger = new DailySpendLedger();
  const lifecycle = new ExecutionLifecycle({ policy, ledger, journal: new ExecutionJournal(), provider: walletProvider });
  await assert.rejects(
    lifecycle.submit(rawIntent, { now }),
    (error) => error instanceof ExecutionLifecycleError && error.stage === "broadcasting",
  );
  assert.equal(ledger.snapshot(now).spentWei, "100");
});

test("reports a mined revert without treating it as confirmation", async () => {
  const lifecycle = new ExecutionLifecycle({
    policy, ledger: new DailySpendLedger(), journal: new ExecutionJournal(),
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
    policy, ledger: new DailySpendLedger(), journal,
    provider: provider({ async broadcast() { throw new Error("network-down"); } }),
  });
  await assert.rejects(lifecycle.submit(rawIntent, { now }));
  assert.deepEqual(transitions, ["reserved", "signed"]);
  assert.equal(journal.get(rawIntent.id).transactionHash, hash);
});

test("reconciles a pending transaction after restart without signing or broadcasting", async () => {
  const journal = new ExecutionJournal({ records: [{
    intentId: rawIntent.id, status: "broadcast", transactionHash: hash, createdAt: now, updatedAt: now,
  }] });
  const walletProvider = provider({ async getReceipt() { return { status: "success", blockNumber: 12 }; } });
  const lifecycle = new ExecutionLifecycle({
    policy, ledger: new DailySpendLedger(), journal, provider: walletProvider,
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
    policy, ledger: new DailySpendLedger(), journal, provider: walletProvider,
  });
  const [result] = await lifecycle.recoverPending({ now: now + 1 });
  assert.equal(result.recovery, "still-pending");
  assert.deepEqual(walletProvider.calls.map(([name]) => name), ["getReceipt"]);
});
