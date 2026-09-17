import test from "node:test";
import assert from "node:assert/strict";
import {
  PAPER_LIFECYCLE_CANDIDATE_HYPOTHESIS,
  PAPER_LIFECYCLE_CANDIDATE_RISK_POLICY,
  PAPER_LIFECYCLE_CANDIDATE_STRATEGY,
  adaptiveTrailingDrawdownPct,
  estimateObservedVolatilityPct,
  lifecycleTelemetry,
  planPaperLifecycleExit,
  validatePaperLifecyclePolicy,
} from "./paper-lifecycle-candidate.js";
import {
  PAPER_FREQUENCY_CANDIDATE_RISK_POLICY,
  PAPER_FREQUENCY_CANDIDATE_STRATEGY,
} from "./paper-frequency-candidate.js";

const minute = 60_000;
const now = 1_000_000;

test("lifecycle candidate preserves the frequency candidate entry policy", () => {
  assert.deepEqual(PAPER_LIFECYCLE_CANDIDATE_RISK_POLICY,
    PAPER_FREQUENCY_CANDIDATE_RISK_POLICY);
  assert.equal(PAPER_LIFECYCLE_CANDIDATE_HYPOTHESIS.activation.runtimeEnabled, false);
  assert.equal(PAPER_LIFECYCLE_CANDIDATE_HYPOTHESIS.activation.currentCohortUnchanged, true);
});

test("lifecycle candidate preserves every frequency-candidate entry field", () => {
  for (const field of [
    "entryCashPct", "maxEntryNotional", "maxEntriesPerPool",
    "reentryCooldownMs", "entryWindowMs",
  ]) {
    assert.equal(PAPER_LIFECYCLE_CANDIDATE_STRATEGY[field],
      PAPER_FREQUENCY_CANDIDATE_STRATEGY[field], field);
  }
  assert.equal(PAPER_LIFECYCLE_CANDIDATE_STRATEGY.entryWindowMs, 6 * 60 * 60_000);
  assert.equal(PAPER_LIFECYCLE_CANDIDATE_STRATEGY.maxHoldMs, 90 * minute);
});

test("catastrophe stop replaces an ordinary tight stop", () => {
  assert.equal(planPaperLifecycleExit({
    returnPct: -12, peakReturnPct: 0, openedAt: now,
  }, now), null);
  assert.deepEqual(planPaperLifecycleExit({
    returnPct: -18, peakReturnPct: 0, openedAt: now,
  }, now), { reason: "catastrophe-stop", closeFraction: 1 });
});

test("trailing stop activates only after positive movement", () => {
  assert.equal(planPaperLifecycleExit({
    returnPct: -7, peakReturnPct: 2, openedAt: now,
    observedVolatilityPct: 4,
  }, now), null);
  assert.deepEqual(planPaperLifecycleExit({
    returnPct: 3, peakReturnPct: 10, openedAt: now,
    observedVolatilityPct: 4,
  }, now), {
    reason: "adaptive-trailing-stop", closeFraction: 1, trailWidthPct: 6,
  });
});

test("adaptive trail widens with volatility but remains bounded", () => {
  assert.equal(adaptiveTrailingDrawdownPct(2), 6);
  assert.equal(adaptiveTrailingDrawdownPct(6), 9);
  assert.equal(adaptiveTrailingDrawdownPct(20), 12);
  assert.equal(adaptiveTrailingDrawdownPct(null), 6);
});

test("takes one partial profit before allowing the remainder to run", () => {
  assert.deepEqual(planPaperLifecycleExit({
    returnPct: 20, peakReturnPct: 20, openedAt: now,
  }, now), { reason: "partial-take-profit", closeFraction: 0.5 });
  assert.equal(planPaperLifecycleExit({
    returnPct: 20, peakReturnPct: 20, openedAt: now, partialProfitTaken: true,
  }, now), null);
  assert.deepEqual(planPaperLifecycleExit({
    returnPct: 50, peakReturnPct: 50, openedAt: now, partialProfitTaken: true,
  }, now), { reason: "final-take-profit", closeFraction: 1 });
});

test("an already-triggered protective trail precedes a first partial profit", () => {
  assert.deepEqual(planPaperLifecycleExit({
    returnPct: 22, peakReturnPct: 30, openedAt: now,
    observedVolatilityPct: 2,
  }, now), {
    reason: "adaptive-trailing-stop", closeFraction: 1, trailWidthPct: 6,
  });
});

test("time stop closes stagnant trades without clipping early momentum", () => {
  assert.equal(planPaperLifecycleExit({
    returnPct: 0, peakReturnPct: 2, openedAt: now - 14 * minute,
  }, now), null);
  assert.deepEqual(planPaperLifecycleExit({
    returnPct: 0, peakReturnPct: 2, openedAt: now - 15 * minute,
  }, now), { reason: "stagnation-time-stop", closeFraction: 1 });
  assert.equal(planPaperLifecycleExit({
    returnPct: 4, peakReturnPct: 5, openedAt: now - 15 * minute,
  }, now), null);
});

test("liquidity collapse takes priority over reported return", () => {
  assert.deepEqual(planPaperLifecycleExit({
    returnPct: -30, peakReturnPct: 0, exitPriceImpactPct: 25, openedAt: now,
  }, now), { reason: "liquidity-collapse", closeFraction: 1 });
});

test("records maximum favorable and adverse excursion", () => {
  let telemetry = lifecycleTelemetry({}, 4);
  telemetry = lifecycleTelemetry(telemetry, -7);
  telemetry = lifecycleTelemetry(telemetry, 11);
  assert.deepEqual(telemetry, {
    maxFavorableExcursionPct: 11,
    maxAdverseExcursionPct: -7,
  });
});

test("first telemetry observation is not fabricated at break-even", () => {
  assert.deepEqual(lifecycleTelemetry({}, 5), {
    maxFavorableExcursionPct: 5,
    maxAdverseExcursionPct: 5,
  });
  assert.throws(() => lifecycleTelemetry({ maxAdverseExcursionPct: "bad" }, 1),
    /invalid-lifecycle-telemetry/);
});

test("estimates observed volatility from a bounded numeric price window", () => {
  assert.equal(estimateObservedVolatilityPct([1, 1.01, 0.99, 1.02]), null);
  const volatility = estimateObservedVolatilityPct([1, 1.01, 0.99, 1.02, 1.03]);
  assert.equal(typeof volatility, "number");
  assert.ok(volatility > 0);
  assert.equal(estimateObservedVolatilityPct([1, 1.01, "0.99", 1.02, 1.03]), null);
  assert.equal(estimateObservedVolatilityPct([1, 1.01, 0, 1.02, 1.03]), null);
});

test("full lifecycle policy validation rejects missing and malformed controls", () => {
  assert.equal(validatePaperLifecyclePolicy(PAPER_LIFECYCLE_CANDIDATE_STRATEGY),
    PAPER_LIFECYCLE_CANDIDATE_STRATEGY);
  for (const [field, value] of [
    ["partialCloseFraction", "oops"],
    ["partialCloseFraction", 0],
    ["catastropheStopPct", undefined],
    ["liquidityCollapseImpactPct", undefined],
    ["stagnationAfterMs", undefined],
    ["maxHoldMs", undefined],
  ]) {
    assert.throws(() => planPaperLifecycleExit({
      returnPct: -99, peakReturnPct: 0, openedAt: now,
    }, now, { ...PAPER_LIFECYCLE_CANDIDATE_STRATEGY, [field]: value }),
    /invalid-lifecycle-policy/, field);
  }
});

test("post-partial positions retain every full-exit protection", () => {
  assert.deepEqual(planPaperLifecycleExit({
    returnPct: -18, peakReturnPct: 25, openedAt: now, partialProfitTaken: true,
  }, now), { reason: "catastrophe-stop", closeFraction: 1 });
  assert.deepEqual(planPaperLifecycleExit({
    returnPct: 10, peakReturnPct: 20, openedAt: now, partialProfitTaken: true,
  }, now), { reason: "adaptive-trailing-stop", closeFraction: 1, trailWidthPct: 6 });
  assert.deepEqual(planPaperLifecycleExit({
    returnPct: 50, peakReturnPct: 50, openedAt: now, partialProfitTaken: true,
  }, now), { reason: "final-take-profit", closeFraction: 1 });
});

test("invalid adaptive trail policy fails closed", () => {
  assert.throws(() => adaptiveTrailingDrawdownPct(4, {
    ...PAPER_LIFECYCLE_CANDIDATE_STRATEGY,
    maximumTrailingDrawdownPct: 2,
  }), /invalid-adaptive-trail-policy/);
});
