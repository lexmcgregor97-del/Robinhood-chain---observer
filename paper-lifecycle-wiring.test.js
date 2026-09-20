import test from "node:test";
import assert from "node:assert/strict";
import {
  PAPER_LIFECYCLE_WIRING_BOUNDARY,
  prepareLifecycleMark,
  prepareLifecyclePaperEntry,
} from "./paper-lifecycle-wiring.js";

const candidate = {
  address: "pool",
  riskGate: { eligibleForPaperEntry: true },
  marketSafety: {
    tokenPriceQuote: 1, gasCostQuotePerSide: 0, baseTokenDecimals: 18,
    buyAmountOut: "2000000000000000000", plannedNotionalQuote: 2,
    quoteToken: "quote", baseToken: "token",
    priceImpactPct: 0.3, exitPriceImpactPct: 0.4,
  },
};
const portfolio = { cash: 100, openPositions: [], trades: [] };

test("entry wiring freezes the risk boundary and resizes the order", () => {
  const plan = prepareLifecyclePaperEntry(candidate, portfolio, 1);
  assert.equal(plan.approved, true);
  assert.equal(plan.order.notional, 2);
  assert.equal(plan.order.entryAdverseBoundaryPct, 20);
  assert.equal(plan.lifecycleRisk.riskBudgetPct, 0.4);
});

test("entry sizing selects the standard boundary from asymmetric exit impact", () => {
  const plan = prepareLifecyclePaperEntry({
    ...candidate,
    marketSafety: {
      ...candidate.marketSafety,
      priceImpactPct: 0.5,
      exitPriceImpactPct: 0.9,
      plannedNotionalQuote: 4 / 3,
      buyAmountOut: "1000000000000000000",
    },
  }, portfolio, 1);
  assert.equal(plan.approved, true);
  assert.equal(plan.order.entryAdverseBoundaryPct, 30);
  assert.ok(Math.abs(plan.order.notional - (4 / 3)) < 1e-12);
});

test("mark wiring carries decision evidence into the close contract", () => {
  const result = prepareLifecycleMark({
    position: { openedAt: 1, entryAdverseBoundaryPct: 20,
      observedPrices: [1, 0.95], lastLifecycleMarkAt: 10_000 },
    marked: { markPrice: 0.8, returnPct: -20, peakReturnPct: 0 },
    signal: { state: "active", swapsCurrentWindow: 4, acceleration: 1 },
    marketSafety: { liquidityKnown: true, sellMathOk: true,
      sellProbe: { passed: true }, priceImpactPct: 1 },
    timestamp: 23_000,
  });
  assert.equal(result.decision.reason, "volatility-risk-boundary");
  assert.equal(result.recordBeforeClose, true);
  assert.equal(result.close.appliedBoundaryPct, 20);
  assert.equal(result.close.audit.observedMarkIntervalMs, 13_000);
});

test("caller contract rejects non-monotonic clocks before mutation", () => {
  assert.throws(() => prepareLifecycleMark({
    position: { lastLifecycleMarkAt: 10 }, timestamp: 10,
  }), /invalid-lifecycle-mark-clock/);
});

test("wiring remains dormant and cannot reach live execution", () => {
  assert.deepEqual(PAPER_LIFECYCLE_WIRING_BOUNDARY, {
    runtimeEnabled: false, cohortRegistered: false, liveExecutionSupported: false,
  });
});
