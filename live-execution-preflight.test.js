import test from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData } from "viem";
import { assessLiveExecutionPreflight, createLiveExecutionPreflight }
  from "./live-execution-preflight.js";
import { V2_ROUTER_ABI } from "./router-calldata.js";

const A = "0x0000000000000000000000000000000000000001";
const B = "0x0000000000000000000000000000000000000002";
const P = "0x0000000000000000000000000000000000000003";
const R = "0x0000000000000000000000000000000000000004";
const W = "0x0000000000000000000000000000000000000005";
const NOW = 2_000_000;
const intent = { data: encodeFunctionData({ abi: V2_ROUTER_ABI,
  functionName: "swapExactTokensForTokens",
  args: [100n, 150n, [A, B], W, 2060n] }) };
const plan = { poolAddress: P, token0: A, token1: B, dex: "uniswap",
  strategyApproved: true, feeBps: 30 };
const evidence = { readiness: { eligibleForMicroMainnet: true },
  strategy: { approved: true },
  signing: { credentialVerified: true, policyVerified: true },
  sellProbe: { passed: true, checkedAt: new Date(NOW - 1).toISOString() },
  approvalProbePassed: true,
  chain: { poolAddress: P, token0: A, token1: B, reserveIn: "1000000",
    reserveOut: "2000000", blockNumber: 10, latestBlock: 11, observedAt: NOW - 1,
    blockTimestampMs: NOW - 1,
    wethBalanceWei: "100", nativeBalanceWei: "50", allowanceWei: "100" },
  minimumNativeBalanceWei: "25", maximumAllowanceWei: "100" };

test("approves only a fresh independently supplied execution snapshot", () => {
  assert.deepEqual(assessLiveExecutionPreflight({ intent, plan, ...evidence, now: NOW }).failures, []);
});

test("fails closed on price movement, stale sell evidence, and allowance widening", () => {
  const result = assessLiveExecutionPreflight({ intent, plan, ...evidence, now: NOW,
    sellProbe: { ...evidence.sellProbe, checkedAt: new Date(NOW - 20_000).toISOString() },
    chain: { ...evidence.chain, reserveOut: "1000000", allowanceWei: "101" } });
  assert.ok(result.failures.includes("live-sell-probe-stale"));
  assert.ok(result.failures.includes("live-price-moved-below-minimum"));
  assert.ok(result.failures.includes("live-router-allowance-exceeds-cap"));
});

test("refuses when the independently repeated strategy check has decayed", () => {
  const result = assessLiveExecutionPreflight({ intent, plan, ...evidence, now: NOW,
    strategy: { approved: false } });
  assert.ok(result.failures.includes("live-strategy-no-longer-approved"));
});

test("refuses a provider whose reported chain head is stale", () => {
  const result = assessLiveExecutionPreflight({ intent, plan, ...evidence, now: NOW,
    chain: { ...evidence.chain, blockTimestampMs: NOW - 60_001 } });
  assert.ok(result.failures.includes("live-chain-head-stale"));
});

test("preflight refuses an intent without an in-memory immutable plan", async () => {
  const preflight = createLiveExecutionPreflight({ plans: new Map(), inspect: async () => evidence });
  assert.deepEqual((await preflight({ id: "unknown" })).failures, ["live-intent-plan-missing"]);
});
