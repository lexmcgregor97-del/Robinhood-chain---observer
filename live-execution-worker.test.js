import test from "node:test";
import assert from "node:assert/strict";
import { LiveExecutionWorker, createObserverCandidateSource } from "./live-execution-worker.js";

const WETH = "0x0000000000000000000000000000000000000001";
const TOKEN = "0x0000000000000000000000000000000000000002";
const POOL = "0x0000000000000000000000000000000000000003";
const ROUTER = "0x0000000000000000000000000000000000000004";
const WALLET = "0x0000000000000000000000000000000000000005";
const candidate = { version: "v2", dex: "uniswap", address: POOL,
  token0: WETH, token1: TOKEN, marketSafety: { forged: true } };
const snapshot = { poolAddress: POOL, token0: WETH, token1: TOKEN,
  reserve0: "1000000", reserve1: "2000000", blockNumber: 42,
  strategyApproved: true };
const config = { chainId: 4663, walletAddress: WALLET, wethAddress: WETH,
  allowedRouters: [ROUTER], routerAddress: ROUTER, maxPerTransactionWei: "1000",
  amountInWei: "100", slippageBps: 100, deadlineSeconds: 60 };

test("uses the observer only as a hint and submits a rebuilt immutable intent", async () => {
  let submitted;
  const plans = new Map();
  const worker = new LiveExecutionWorker({
    source: { fetchCandidates: async () => [candidate] },
    inspectCandidate: async (hint) => {
      assert.equal(hint.marketSafety, undefined);
      return snapshot;
    },
    journal: { pending: () => [] }, plans, config,
    lifecycle: { submit: async (intent) => {
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
  lifecycle: {}, journal: { pending: () => [{ intentId: "x" }] }, plans: new Map(), config });
  assert.equal((await worker.runOnce()).reason, "pending-execution-review-required");
  assert.equal(fetched, false);
});

test("observer source requires HTTPS and paper fail-closed response shape", async () => {
  assert.throws(() => createObserverCandidateSource({ url: "http://example.com" }),
    /https-required/);
  const source = createObserverCandidateSource({ url: "https://observer.example",
    fetchImpl: async () => ({ ok: true, json: async () => ({ mode: "LIVE", candidates: [] }) }) });
  await assert.rejects(source.fetchCandidates(), /source-invalid/);
});
