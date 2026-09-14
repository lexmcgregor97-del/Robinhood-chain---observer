import test from "node:test";
import assert from "node:assert/strict";
import {
  ShadowEvaluator, shadowRuleMatches, evaluateShadowPromotion,
} from "./shadow-evaluator.js";

const escapeRule = { name: "escape-activity", signal: "escape-velocity", maxDeviationPct: 5 };

function candidate(signal = "escape-velocity", price = 2, address = "0xpool") {
  return {
    address,
    signal: { state: signal, swapsCurrentWindow: 8, acceleration: 3 },
    marketSafety: {
      quoteTokenKnown: true,
      quoteToken: "0xquote",
      liquidityKnown: true,
      buyMathOk: true,
      sellMathOk: true,
      priceAuditAvailable: true,
      tokenPriceQuote: price,
      priceImpactPct: 1,
      executionCostPct: 2,
      spotVsLastSwapPct: 1,
    },
  };
}

test("shadow rules fail closed without executable cost evidence", () => {
  assert.equal(shadowRuleMatches(candidate(), escapeRule), true);
  const unsafe = candidate();
  delete unsafe.marketSafety.executionCostPct;
  assert.equal(shadowRuleMatches(unsafe, escapeRule), false);
});

test("records and resolves one five-minute sample", () => {
  const evaluator = new ShadowEvaluator({ horizonMs: 100, rules: [escapeRule] });
  evaluator.observe([candidate()], 1_000);
  evaluator.observe([candidate("escape-velocity", 3)], 1_100);
  const result = evaluator.snapshot();
  assert.deepEqual(result.horizonsMs, [100]);
  assert.equal(result.byRule["escape-activity"].closedSamples, 1);
  assert.equal(result.byRule["escape-activity"].averageReturnPct, 48);
});

test("does not resample a pool while its signal episode remains active", () => {
  const evaluator = new ShadowEvaluator({
    horizonMs: 100, episodeGapMs: 500, rules: [escapeRule],
  });
  evaluator.observe([candidate()], 1_000);
  evaluator.observe([candidate("escape-velocity", 3)], 1_100);
  evaluator.observe([candidate("escape-velocity", 3)], 1_600);
  assert.equal(evaluator.serialize().samples.length, 1);
});

test("allows a new episode only after the pool leaves signal for the full gap", () => {
  const evaluator = new ShadowEvaluator({
    horizonMs: 100, episodeGapMs: 500, rules: [escapeRule],
  });
  evaluator.record([candidate()], 1_000);
  evaluator.record([], 1_499);
  evaluator.record([candidate()], 1_500);
  assert.equal(evaluator.serialize().samples.length, 1);
  evaluator.record([], 2_000);
  evaluator.record([candidate()], 2_001);
  assert.equal(evaluator.serialize().samples.length, 2);
  assert.notEqual(
    evaluator.serialize().samples[0].episodeId,
    evaluator.serialize().samples[1].episodeId,
  );
});

test("censors unavailable prices instead of manufacturing a total loss", () => {
  const evaluator = new ShadowEvaluator({
    horizonMs: 100, resolutionTimeoutMultiplier: 3, rules: [escapeRule],
  });
  evaluator.record([candidate()], 1_000);
  evaluator.resolve([], 1_300);
  const sample = evaluator.serialize().samples[0];
  assert.equal(sample.censorReason, "price-unavailable");
  assert.equal(sample.netReturnPct, undefined);
  const summary = evaluator.snapshot().byRule["escape-activity"];
  assert.equal(summary.censoredSamples, 1);
  assert.equal(summary.closedSamples, 0);
  assert.deepEqual(evaluator.pendingPoolAddresses(), []);
});

test("promotion counts unique pools rather than repeated observations", () => {
  const result = evaluateShadowPromotion({
    closedSamples: 100,
    uniquePools: 3,
    medianReturnPct: 5,
    meanCiLowerPct: 2,
  });
  assert.equal(result.status, "collecting");
  assert.equal(result.remainingUniquePools, 17);
});

test("promotion requires positive median and pool-bootstrap lower bound", () => {
  const promoted = evaluateShadowPromotion({
    closedSamples: 20,
    uniquePools: 20,
    medianReturnPct: 2,
    meanCiLowerPct: 1,
  });
  assert.equal(promoted.eligible, true);
  const rejected = evaluateShadowPromotion({
    closedSamples: 20,
    uniquePools: 20,
    medianReturnPct: -1,
    meanCiLowerPct: -2,
  });
  assert.deepEqual(rejected.failures, [
    "median-return-too-low",
    "mean-confidence-bound-too-low",
  ]);
});

test("steady accumulation remains independent from escape activity", () => {
  const steadyRule = {
    name: "steady-accumulation",
    signal: "active",
    minSwaps: 4,
    minAcceleration: 0.75,
    maxAcceleration: 1.5,
    maxDeviationPct: 5,
  };
  const steady = candidate("active");
  steady.signal.acceleration = 1.2;
  assert.equal(shadowRuleMatches(steady, steadyRule), true);
  assert.equal(shadowRuleMatches(steady, escapeRule), false);
});

test("activity pullback records only after a controlled retracement", () => {
  const pullbackRule = {
    name: "activity-pullback",
    signals: ["active"],
    minSwaps: 3,
    maxDeviationPct: 5,
    pullbackMinPct: 2,
    pullbackMaxPct: 12,
    setupMaxAgeMs: 500,
  };
  const evaluator = new ShadowEvaluator({
    horizonMs: 100, episodeGapMs: 500, rules: [pullbackRule],
  });
  const first = candidate("active", 100);
  first.signal.acceleration = 1;
  evaluator.record([first], 1_000);
  assert.equal(evaluator.serialize().samples.length, 0);
  const retraced = candidate("active", 95);
  retraced.signal.acceleration = 1;
  evaluator.record([retraced], 1_100);
  assert.equal(evaluator.serialize().samples.length, 1);
});

test("legacy tuned samples are retained but excluded from the frozen rule version", () => {
  const evaluator = new ShadowEvaluator({ rules: [escapeRule] });
  evaluator.restore({
    samples: [{
      rule: "escape-activity", pool: "0xold", openedAt: 1,
      closedAt: 2, netReturnPct: 100,
    }],
  });
  assert.equal(evaluator.serialize().samples.length, 1);
  assert.equal(evaluator.snapshot().byRule["escape-activity"].closedSamples, 0);
});


test("snapshot separates legacy samples from the current measurement epoch", () => {
  const evaluator = new ShadowEvaluator({ rules: [escapeRule], horizonMs: 60_000 });
  evaluator.restore({
    samples: [{
      rule: "escape-activity", ruleVersion: "legacy", pool: "0xold",
      openedAt: 1, closedAt: 2, netReturnPct: 10,
    }],
  });
  evaluator.record([candidate()], 10_000);

  const snapshot = evaluator.snapshot();
  assert.equal(snapshot.legacySampleCount, 1);
  assert.equal(snapshot.currentSampleCount, 1);
  assert.equal(snapshot.recentSamples.length, 1);
  assert.equal(snapshot.recentSamples[0].pool, "0xpool");
});
