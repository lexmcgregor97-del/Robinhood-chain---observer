import test from "node:test";
import assert from "node:assert/strict";
import {
  PAPER_LIFECYCLE_CANDIDATE_HYPOTHESIS,
  PAPER_LIFECYCLE_CANDIDATE_RISK_POLICY,
  PAPER_LIFECYCLE_CANDIDATE_STRATEGY,
  adaptiveTrailingDrawdownPct,
  adverseBoundaryPct,
  assessPositionSignal,
  estimateObservedVolatilityPct,
  lifecycleTelemetry,
  planPaperLifecycleExit,
  signalConditionedEntryPlan,
  signalConditionedEntryCashPct,
  updateStopCounterfactuals,
  validatePaperLifecyclePolicy,
} from "./paper-lifecycle-candidate.js";
import {
  PAPER_CONTROL_RISK_POLICY,
  PAPER_CONTROL_STRATEGY,
} from "./paper-control-policy.js";

const minute = 60_000;
const now = 100 * minute;
const healthy = { state: "healthy", reasons: [] };
const weakening = { state: "weakening", reasons: ["activity-weakening"] };
const deepBoundary = { entryAdverseBoundaryPct: 20 };
const standardBoundary = { entryAdverseBoundaryPct: 30 };

test("lifecycle candidate preserves control entry policy in an isolated paper cohort", () => {
  assert.deepEqual(PAPER_LIFECYCLE_CANDIDATE_RISK_POLICY, PAPER_CONTROL_RISK_POLICY);
  for (const field of [
    "maxEntryNotional", "maxEntriesPerPool", "reentryCooldownMs",
  ]) {
    assert.equal(PAPER_LIFECYCLE_CANDIDATE_STRATEGY[field],
      PAPER_CONTROL_STRATEGY[field], field);
  }
  assert.equal(PAPER_LIFECYCLE_CANDIDATE_HYPOTHESIS.activation.runtimeEnabled, true);
  assert.equal(PAPER_LIFECYCLE_CANDIDATE_HYPOTHESIS.activation.cohortRegistered, true);
  assert.equal(PAPER_LIFECYCLE_CANDIDATE_HYPOTHESIS.activation.currentCohortUnchanged, true);
  assert.equal(PAPER_LIFECYCLE_CANDIDATE_HYPOTHESIS.activation.requiresFreshIsolatedCohort, true);
  assert.equal(PAPER_LIFECYCLE_CANDIDATE_HYPOTHESIS.activation.liveExecutionSupported, false);
});

test("signal assessment distinguishes strengthening, healthy, weakening, and invalidated", () => {
  const marketSafety = {
    liquidityKnown: true, sellMathOk: true, priceImpactPct: 1,
    sellProbe: { passed: true },
  };
  assert.equal(assessPositionSignal({
    marketSafety,
    signal: { state: "active", swapsCurrentWindow: 4, acceleration: 1 },
  }).state, "healthy");
  assert.equal(assessPositionSignal({
    marketSafety,
    signal: { state: "breakout-watch", swapsCurrentWindow: 5, acceleration: 2 },
  }).state, "strengthening");
  assert.equal(assessPositionSignal({
    marketSafety,
    signal: { state: "active", swapsCurrentWindow: 3, acceleration: 0.6 },
  }).state, "weakening");
  assert.equal(assessPositionSignal({
    marketSafety,
    signal: { state: "quiet", swapsCurrentWindow: 1, acceleration: 0.2 },
  }).state, "invalidated");
});

test("signal assessment honors an explicit candidate liquidity-collapse policy", () => {
  const input = {
    marketSafety: {
      liquidityKnown: true, sellMathOk: true, priceImpactPct: 4,
      sellProbe: { passed: true },
    },
    signal: { state: "active", swapsCurrentWindow: 4, acceleration: 1 },
  };
  assert.equal(assessPositionSignal(input).state, "healthy");
  assert.equal(assessPositionSignal(input, {
    ...PAPER_LIFECYCLE_CANDIDATE_STRATEGY,
    liquidityCollapseImpactPct: 4,
  }).state, "emergency");
  assert.equal(PAPER_LIFECYCLE_CANDIDATE_STRATEGY.liquidityCollapseImpactPct, 5);
});

test("sellability and liquidity failures always become emergency signals", () => {
  assert.deepEqual(assessPositionSignal({
    marketSafety: { liquidityKnown: true, sellMathOk: false, priceImpactPct: 1 },
  }), { state: "emergency", reasons: ["sellability-unverified"] });
  assert.deepEqual(assessPositionSignal({
    marketSafety: { liquidityZero: true },
  }), { state: "emergency", reasons: ["liquidity-zero"] });
});

test("healthy positive signal holds through price gains and ordinary drawdowns", () => {
  assert.equal(planPaperLifecycleExit({
    ...standardBoundary, returnPct: 80, peakReturnPct: 80, openedAt: now,
  }, now, PAPER_LIFECYCLE_CANDIDATE_STRATEGY, healthy), null);
  assert.equal(planPaperLifecycleExit({
    ...standardBoundary, returnPct: -29, peakReturnPct: 10, openedAt: now,
  }, now, PAPER_LIFECYCLE_CANDIDATE_STRATEGY, healthy), null);
});

test("entry-time liquidity boundaries cap otherwise healthy holds", () => {
  assert.equal(adverseBoundaryPct(0.4), 20);
  assert.equal(adverseBoundaryPct(1), 30);
  assert.throws(() => adverseBoundaryPct(undefined), /invalid-exit-price-impact/);
  assert.deepEqual(planPaperLifecycleExit({
    ...deepBoundary, returnPct: -20, peakReturnPct: 2, openedAt: now,
  }, now, PAPER_LIFECYCLE_CANDIDATE_STRATEGY, healthy), {
    reason: "volatility-risk-boundary", closeFraction: 1,
    entryBoundaryPct: 20, appliedBoundaryPct: 20,
  });
});

test("risk-budget sizing shrinks as the permitted adverse boundary widens", () => {
  assert.equal(signalConditionedEntryCashPct({ exitPriceImpactPct: 0.4 }), 2);
  assert.equal(signalConditionedEntryCashPct({ exitPriceImpactPct: 1 }), 4 / 3);
  assert.deepEqual(signalConditionedEntryPlan({ exitPriceImpactPct: 0.4 }), {
    entryAdverseBoundaryPct: 20, entryCashPct: 2, riskBudgetPct: 0.4,
  });
  assert.equal(2 * 20 / 100, 0.4);
  assert.equal((4 / 3) * 30 / 100, 0.4);
});

test("entry boundary is frozen and never widens with later liquidity drift", () => {
  assert.deepEqual(planPaperLifecycleExit({
    ...deepBoundary, returnPct: -20, peakReturnPct: 2, openedAt: now,
    exitPriceImpactPct: 1,
  }, now, PAPER_LIFECYCLE_CANDIDATE_STRATEGY, healthy), {
    reason: "volatility-risk-boundary", closeFraction: 1,
    entryBoundaryPct: 20, appliedBoundaryPct: 20,
  });
  assert.deepEqual(planPaperLifecycleExit({
    returnPct: 0, peakReturnPct: 0, openedAt: now,
  }, now, PAPER_LIFECYCLE_CANDIDATE_STRATEGY, healthy), {
    reason: "entry-risk-boundary-unavailable", closeFraction: 1,
  });
});

test("weakening does not retroactively tighten a losing position", () => {
  const position = {
    ...deepBoundary, returnPct: -18, peakReturnPct: 1, openedAt: now,
  };
  assert.equal(planPaperLifecycleExit(position, now,
    PAPER_LIFECYCLE_CANDIDATE_STRATEGY, healthy), null);
  assert.equal(planPaperLifecycleExit(position, now,
    PAPER_LIFECYCLE_CANDIDATE_STRATEGY, weakening), null);
});

test("profit taking and trailing protection require a weakening signal", () => {
  const position = {
    ...standardBoundary,
    returnPct: 25, peakReturnPct: 25, openedAt: now,
    observedVolatilityPct: 8, observedMarkIntervalMs: 13_000,
  };
  assert.equal(planPaperLifecycleExit(position, now,
    PAPER_LIFECYCLE_CANDIDATE_STRATEGY, healthy), null);
  assert.deepEqual(planPaperLifecycleExit(position, now,
    PAPER_LIFECYCLE_CANDIDATE_STRATEGY, weakening), {
    reason: "signal-weakening-partial", closeFraction: 0.5,
  });
  assert.deepEqual(planPaperLifecycleExit({
    ...position, partialProfitTaken: true, returnPct: 8, peakReturnPct: 25,
  }, now, PAPER_LIFECYCLE_CANDIDATE_STRATEGY, weakening), {
    reason: "signal-weakening-trail", closeFraction: 1, trailWidthPct: 16,
    observedMarkIntervalMs: 13_000,
  });
});

test("weakening partial outranks trail and post-partial equality triggers the trail", () => {
  const position = {
    ...standardBoundary, returnPct: 22, peakReturnPct: 40, openedAt: now,
    observedVolatilityPct: 6,
  };
  assert.deepEqual(planPaperLifecycleExit(position, now,
    PAPER_LIFECYCLE_CANDIDATE_STRATEGY, weakening), {
    reason: "signal-weakening-partial", closeFraction: 0.5,
  });
  assert.deepEqual(planPaperLifecycleExit({
    ...position, partialProfitTaken: true, returnPct: 28,
  }, now, PAPER_LIFECYCLE_CANDIDATE_STRATEGY, weakening), {
    reason: "signal-weakening-trail", closeFraction: 1, trailWidthPct: 12,
    observedMarkIntervalMs: null,
  });
});

test("invalidated, emergency, and missing assessments fail closed", () => {
  const position = { ...standardBoundary, returnPct: 5, peakReturnPct: 5, openedAt: now };
  assert.deepEqual(planPaperLifecycleExit(position, now), {
    reason: "signal-assessment-unavailable", closeFraction: 1,
  });
  assert.deepEqual(planPaperLifecycleExit(position, now,
    PAPER_LIFECYCLE_CANDIDATE_STRATEGY, { state: "invalidated", reasons: [] }), {
    reason: "signal-invalidated", closeFraction: 1,
  });
  assert.deepEqual(planPaperLifecycleExit(position, now,
    PAPER_LIFECYCLE_CANDIDATE_STRATEGY,
    { state: "emergency", reasons: ["liquidity-collapse"] }), {
    reason: "liquidity-collapse", closeFraction: 1,
  });
});

test("counterfactual stop telemetry records breaches and later recovery", () => {
  let state = updateStopCounterfactuals({}, -22);
  assert.deepEqual(state, {
    8: { breached: true, recoveredToBreakEven: false },
    15: { breached: true, recoveredToBreakEven: false },
    20: { breached: true, recoveredToBreakEven: false },
    30: { breached: false, recoveredToBreakEven: false },
  });
  state = updateStopCounterfactuals(state, 3);
  assert.equal(state["8"].recoveredToBreakEven, true);
  assert.equal(state["20"].recoveredToBreakEven, true);
  assert.equal(state["30"].recoveredToBreakEven, false);
});

test("adaptive trail and volatility telemetry remain bounded and deterministic", () => {
  assert.equal(adaptiveTrailingDrawdownPct(2), 12);
  assert.equal(adaptiveTrailingDrawdownPct(8), 16);
  assert.equal(adaptiveTrailingDrawdownPct(20), 30);
  assert.deepEqual(lifecycleTelemetry(lifecycleTelemetry({}, 4), -7), {
    maxFavorableExcursionPct: 4,
    maxAdverseExcursionPct: -7,
  });
  assert.equal(estimateObservedVolatilityPct([1, 1.01, 0.99, 1.02]), null);
  assert.ok(estimateObservedVolatilityPct([1, 1.01, 0.99, 1.02, 1.03]) > 0);
});

test("absolute maximum hold remains a final fail-safe", () => {
  assert.deepEqual(planPaperLifecycleExit({
    returnPct: 100, peakReturnPct: 100,
    openedAt: now - 24 * 60 * minute, ...standardBoundary,
  }, now, PAPER_LIFECYCLE_CANDIDATE_STRATEGY, healthy), {
    reason: "absolute-max-hold", closeFraction: 1,
  });
});

test("policy validation rejects incomplete or contradictory controls", () => {
  assert.equal(validatePaperLifecyclePolicy(PAPER_LIFECYCLE_CANDIDATE_STRATEGY),
    PAPER_LIFECYCLE_CANDIDATE_STRATEGY);
  for (const [field, value] of [
    ["riskBudgetPct", 0],
    ["partialCloseFraction", 1],
    ["deepLiquidityAdverseBoundaryPct", 40],
    ["absoluteMaxHoldMs", undefined],
  ]) {
    assert.throws(() => validatePaperLifecyclePolicy({
      ...PAPER_LIFECYCLE_CANDIDATE_STRATEGY, [field]: value,
    }), /invalid-lifecycle-policy/);
  }
});
