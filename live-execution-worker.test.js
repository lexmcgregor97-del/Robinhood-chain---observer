import test from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData } from "viem";
import { LiveExecutionWorker, createObserverCandidateSource } from "./live-execution-worker.js";
import { LivePositionLedger } from "./live-position-ledger.js";
import { APPROVE_ABI } from "./approval-calldata.js";

const WETH = "0x0000000000000000000000000000000000000001";
const TOKEN = "0x0000000000000000000000000000000000000002";
const POOL = "0x0000000000000000000000000000000000000003";
const ROUTER = "0x0000000000000000000000000000000000000004";
const WALLET = "0x0000000000000000000000000000000000000005";
const candidate = { version: "v2", dex: "uniswap", address: POOL,
  token0: WETH, token1: TOKEN, marketSafety: { forged: true } };
const snapshot = { poolAddress: POOL, token0: WETH, token1: TOKEN,
  reserve0: "1000000", reserve1: "2000000", blockNumber: 42,
  strategyApproved: true, feeBps: 30 };
const config = { chainId: 4663, walletAddress: WALLET, wethAddress: WETH,
  allowedRouters: [ROUTER], routerAddress: ROUTER, maxPerTransactionWei: "1000",
  amountInWei: "100", slippageBps: 100, deadlineSeconds: 60 };
const emptyPositions = { hasProcessed: () => false, openPositions: () => [],
  open: async () => {}, mark: async () => {}, requestExit: async () => {},
  cancelExit: async () => {}, close: async () => {} };

test("uses the observer only as a hint and submits a rebuilt immutable intent", async () => {
  let submitted;
  const plans = new Map();
  const worker = new LiveExecutionWorker({
    source: { fetchCandidates: async () => [candidate] },
    inspectCandidate: async (hint) => {
      assert.equal(hint.marketSafety, undefined);
      return snapshot;
    },
    journal: { pending: () => [], snapshot: () => ({ records: [] }), get: () => null },
    positions: emptyPositions, submitExit: async () => {}, submitApproval: async () => {},
    probeExit: async () => ({ approved: true }),
    plans, config,
    lifecycle: { recoverPending: async () => [], submit: async (intent) => {
      submitted = intent;
      assert.ok(plans.has(intent.id));
      return { status: "confirmed" };
    } },
  });
  const result = await worker.runOnce({ now: 1_000_000 });
  assert.equal(result.status, "submitted");
  assert.equal(submitted.spendAmount, "100");
  assert.equal(plans.size, 0);
});

test("pending execution blocks candidate retrieval", async () => {
  let fetched = false;
  const worker = new LiveExecutionWorker({ source: { fetchCandidates: async () => {
    fetched = true; return []; } }, inspectCandidate: async () => snapshot,
  lifecycle: { recoverPending: async () => [] }, journal: { pending: () => [{ intentId: "x" }] },
  positions: emptyPositions, submitExit: async () => {}, submitApproval: async () => {},
  probeExit: async () => ({ approved: true }),
  plans: new Map(), config });
  assert.equal((await worker.runOnce()).reason, "pending-execution-review-required");
  assert.equal(fetched, false);
});

test("observer source requires HTTPS and paper fail-closed response shape", async () => {
  assert.throws(() => createObserverCandidateSource({ url: "http://example.com" }),
    /https-required/);
  const source = createObserverCandidateSource({ url: "https://observer.example",
    expectedHostname: "observer.example",
    bearerToken: "a".repeat(32),
    fetchImpl: async () => ({ ok: true, json: async () => ({ mode: "LIVE", candidates: [] }) }) });
  await assert.rejects(source.fetchCandidates(), /source-invalid/);
  assert.throws(() => createObserverCandidateSource({ url: "https://observer.example",
    expectedHostname: "different.example", bearerToken: "a".repeat(32) }),
  /hostname-mismatch/);
});

test("submits an exact-unit exit when the durable stop is reached", async () => {
  const positions = new LivePositionLedger();
  await positions.open({ poolAddress: POOL, baseToken: TOKEN, routerAddress: ROUTER,
    baseUnits: "100", entryWethWei: "100", feeBps: 30, entryIntentId: "buy:1",
    entryTransactionHash: `0x${"1".repeat(64)}`, openedAt: 1 }, 1);
  let sold;
  const worker = new LiveExecutionWorker({ source: { fetchCandidates: async () => [] },
    inspectCandidate: async () => snapshot,
    inspectPosition: async () => ({ ...snapshot, baseAllowanceWei: "100" }),
    lifecycle: { recoverPending: async () => [] },
    submitApproval: async () => { throw new Error("approval-unexpected"); },
    probeExit: async () => ({ approved: true }),
    submitExit: async (intent) => { sold = intent; return { status: "rejected" }; },
    journal: { pending: () => [], snapshot: () => ({ records: [] }), get: () => null },
    positions, plans: new Map(), config: { ...config,
      exitPolicy: { stopLossPct: 8, takeProfitPct: 35,
        trailingActivationPct: 10, trailingDrawdownPct: 6, maxHoldMs: 1_000_000 } } });
  const result = await worker.runOnce({ now: 2 });
  assert.equal(result.status, "exit-submitted");
  assert.equal(result.reason, "stop-loss");
  assert.equal(sold.spendAmount, "100");
  assert.equal(positions.get(POOL).status, "open");
});

test("submits an exact approval before an exit when allowance is absent", async () => {
  const positions = new LivePositionLedger();
  await positions.open({ poolAddress: POOL, baseToken: TOKEN, routerAddress: ROUTER,
    baseUnits: "100", entryWethWei: "100", feeBps: 30, entryIntentId: "buy:1",
    entryTransactionHash: `0x${"1".repeat(64)}`, openedAt: 1 }, 1);
  let approved;
  const worker = new LiveExecutionWorker({ source: { fetchCandidates: async () => [] },
    inspectCandidate: async () => snapshot,
    inspectPosition: async () => ({ ...snapshot, baseAllowanceWei: "0" }),
    lifecycle: { recoverPending: async () => [] },
    submitApproval: async (intent) => { approved = intent; return { status: "confirmed" }; },
    submitExit: async () => { throw new Error("exit-unexpected"); },
    probeExit: async () => ({ approved: true }),
    journal: { pending: () => [], snapshot: () => ({ records: [] }), get: () => null },
    positions, plans: new Map(), config: { ...config, exitPolicy: {} } });
  const result = await worker.runOnce({ now: 2 });
  assert.equal(result.status, "approval-submitted");
  assert.equal(approved.spendAmount, "100");
});

test("zeroes a residual allowance before attempting the exact exit approval", async () => {
  const positions = new LivePositionLedger();
  await positions.open({ poolAddress: POOL, baseToken: TOKEN, routerAddress: ROUTER,
    baseUnits: "100", entryWethWei: "100", feeBps: 30, entryIntentId: "buy:1",
    entryTransactionHash: `0x${"1".repeat(64)}`, openedAt: 1 }, 1);
  let reset;
  const worker = new LiveExecutionWorker({ source: { fetchCandidates: async () => [] },
    inspectCandidate: async () => snapshot,
    inspectPosition: async () => ({ ...snapshot, baseAllowanceWei: "7" }),
    lifecycle: { recoverPending: async () => [] },
    submitApproval: async (intent) => { reset = intent; return { status: "confirmed" }; },
    submitExit: async () => { throw new Error("exit-unexpected"); },
    probeExit: async () => ({ approved: true }),
    journal: { pending: () => [], snapshot: () => ({ records: [] }), get: () => null },
    positions, plans: new Map(), config: { ...config, exitPolicy: {} } });
  assert.equal((await worker.runOnce({ now: 2 })).status, "approval-submitted");
  const call = decodeFunctionData({ abi: APPROVE_ABI, data: reset.data });
  assert.equal(reset.purpose, "live-exit-approval-reset");
  assert.equal(call.args[1], 0n);
});
