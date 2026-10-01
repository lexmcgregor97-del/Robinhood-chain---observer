import test from "node:test";
import assert from "node:assert/strict";
import { createGasRefresher, observedGasTransactions } from "./gas-refresh.js";
import { gasMeasurementFromEnv } from "./gas-measurement.js";
import { evaluateRiskGate } from "./risk-gate.js";
import { PAPER_OPPORTUNITY_CANDIDATE_RISK_POLICY as riskPolicy,
  PAPER_OPPORTUNITY_CANDIDATE_STRATEGY as strategy } from "./paper-opportunity-candidate.js";
import { prepareLifecyclePaperEntry } from "./paper-lifecycle-wiring.js";
import { PaperPortfolio } from "./paper-portfolio.js";
import { selectSellProbeTargets } from "./sell-probe-targets.js";

const now = Date.parse("2026-10-01T22:00:00Z");
const oldHash = `0x${"a".repeat(64)}`;
const newHash = `0x${"b".repeat(64)}`;
const router = `0x${"c".repeat(40)}`;
const quote = `0x${"d".repeat(40)}`;
const config = gasMeasurementFromEnv({ PAPER_GAS_MEASUREMENT_TX: oldHash,
  PAPER_V2_ROUTER_ADDRESSES: router, PAPER_WETH_GAS_PER_SIDE: "0.001" });
const receipt = { status: "0x1", to: router, blockNumber: "0x2",
  gasUsed: "0x186a0", effectiveGasPrice: "0x3b9aca00", gasUsedForL1: "0x2710" };
const block = (ms) => ({ timestamp: `0x${Math.floor(ms / 1000).toString(16)}` });
function harness(overrides = {}) {
  const calls = [];
  const refresher = createGasRefresher({ config,
    getReceipt: async (hash) => {
      calls.push(hash); return { ...receipt, blockNumber: hash === oldHash ? "0x1" : "0x2" };
    },
    getBlock: async (number) => block(number === "0x1" ? now - 8 * 86400_000 : now),
    ...overrides });
  return { refresher, calls };
}

test("expired bootstrap recovers with an observed swap and bounded retry", async () => {
  const { refresher, calls } = harness();
  assert.deepEqual((await refresher.refresh({ now })).failures, ["gas-measurement-stale"]);
  await refresher.refresh({ now: now + 1, transactionHashes: [newHash] });
  assert.equal(calls.length, 1);
  const result = await refresher.refresh({ now: now + 300_000, transactionHashes: [newHash] });
  assert.equal(result.verifiedInput, true);
  assert.equal(result.renewal.source, "observed-swap");
  assert.equal(result.configuredWethPerSide, config.configuredWethPerSide);
  assert.equal(refresher.snapshot(now + 8 * 86400_000).verifiedInput, false);
});

test("renewal is deduplicated, capped at three samples, and shares in-flight work", async () => {
  const { refresher, calls } = harness({ getBlock: async () => block(0) });
  const hashes = [newHash, newHash, ...["e", "f", "1"].map((s) => `0x${s.repeat(64)}`)];
  const first = refresher.refresh({ now, transactionHashes: hashes });
  const second = refresher.refresh({ now, transactionHashes: hashes });
  assert.equal(first, second);
  assert.equal((await first).verifiedInput, false);
  assert.equal(calls.length, 3);
});

test("new receipts still reject wrong routers, missing L1 evidence, and high gas costs", async () => {
  for (const change of [{ to: quote }, { gasUsedForL1: undefined },
    { effectiveGasPrice: "0xffffffffffff" }]) {
    const { refresher } = harness({ getReceipt: async () => ({ ...receipt, ...change }) });
    assert.equal((await refresher.refresh({ now, transactionHashes: [newHash] })).verifiedInput, false);
  }
});

test("a more expensive sample cannot be hidden by a cheaper fallback", async () => {
  let calls = 0;
  const { refresher } = harness({ getReceipt: async () => {
    calls += 1; return { ...receipt, effectiveGasPrice: "0xffffffffffff" };
  } });
  const result = await refresher.refresh({ now, transactionHashes: [newHash, oldHash] });
  assert.ok(result.failures.includes("gas-weth-assumption-below-observed"));
  assert.equal(calls, 1);
});

test("observations exclude old, future, wrong-quote and V3 swaps", () => {
  const pool = { version: "v2", token0: quote, token1: router,
    lastSwapTimestampMs: now, lastSwap: { transactionHash: newHash } };
  assert.deepEqual(observedGasTransactions([pool, { ...pool, version: "v3" },
    { ...pool, token0: router }, { ...pool, lastSwapTimestampMs: now + 1 },
    { ...pool, lastSwapTimestampMs: now - config.maxAgeMs }], quote, now, config.maxAgeMs), [newHash]);
});

test("missing bootstrap hash can recover, missing router configuration cannot", async () => {
  const missingHash = gasMeasurementFromEnv({ PAPER_V2_ROUTER_ADDRESSES: router,
    PAPER_WETH_GAS_PER_SIDE: "0.001" });
  const { refresher } = harness({ config: missingHash });
  assert.equal((await refresher.refresh({ now, transactionHashes: [newHash] })).verifiedInput, true);
  const bad = harness({ config: gasMeasurementFromEnv({}) });
  assert.equal((await bad.refresher.refresh({ now, transactionHashes: [newHash] })).verifiedInput, false);
  assert.equal(bad.calls.length, 0);
});

test("offline opportunity cohort opens a paper position only after gas and sell evidence pass", async () => {
  const portfolio = new PaperPortfolio({ initialCash: 100 });
  const candidate = { address: "pool", version: "v2",
    signal: { state: "breakout-watch", swapsCurrentWindow: 5, acceleration: 2 },
    lastSellSwap: { transactionHash: newHash },
    marketSafety: { quoteTokenKnown: true, liquidityKnown: true, buyMathOk: true,
      sellMathOk: true, gasEstimateAvailable: false, sellProbe: { passed: false },
      priceAuditAvailable: true, spotVsLastSwapPct: 1, poolAgeMs: 600_000,
      priceImpactPct: 0.3, exitPriceImpactPct: 0.3, executionCostPct: 1,
      tokenPriceQuote: 1, gasCostQuotePerSide: 0.001, baseTokenDecimals: 18,
      buyAmountOut: "2000000000000000000", plannedNotionalQuote: 2,
      quoteToken: quote, baseToken: router } };
  const plan = () => {
    candidate.riskGate = evaluateRiskGate(candidate, riskPolicy);
    return prepareLifecyclePaperEntry(candidate, portfolio.serialize(), now, strategy);
  };
  assert.equal(plan().approved, false);
  const { refresher } = harness();
  const gas = await refresher.refresh({ now, transactionHashes: [newHash] });
  candidate.marketSafety.gasEstimateAvailable = gas.verifiedInput;
  assert.equal(plan().approved, false); // Gas alone must never bypass a sell check.
  const diagnostics = {};
  const targets = selectSellProbeTargets([candidate], { diagnostics,
    observedSellFor: (c) => c.lastSellSwap, hasFreshProbe: () => false,
    isPaperEntryEligible: (c) => evaluateRiskGate({ ...c, marketSafety: {
      ...c.marketSafety, sellProbe: { passed: true },
    } }, riskPolicy).eligibleForPaperEntry });
  assert.equal(targets.length, 1);
  assert.equal(diagnostics.selected, 1);
  // Recorded successful simulation evidence, not a network transaction.
  candidate.marketSafety.sellProbe = { passed: true };
  const approved = plan();
  assert.equal(approved.approved, true);
  portfolio.open({ ...approved.order, timestamp: now });
  assert.equal(portfolio.positions.size, 1);
  assert.ok(portfolio.cash < 100);
});
