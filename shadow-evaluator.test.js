import test from "node:test";
import assert from "node:assert/strict";
import {
  ShadowEvaluator, shadowRuleMatches, evaluateShadowPromotion,
} from "./shadow-evaluator.js";

function candidate(signal = "escape-velocity", price = 2, deviation = 4) {
  return {
    address: "0xpool", signal: { state: signal },
    marketSafety: {
      quoteTokenKnown: true, quoteToken: "0xquote", liquidityKnown: true,
      buySimulationOk: true, sellSimulationOk: true, priceAuditAvailable: true,
      tokenPriceQuote: price, priceImpactPct: 1, roundTripLossPct: 2,
      spotVsLastSwapPct: deviation,
    },
  };
}

test("shadow rules fail closed on incomplete safety evidence", () => {
  assert.equal(shadowRuleMatches(candidate(), {
    signal: "escape-velocity", maxDeviationPct: 5,
  }), true);
  const unsafe = candidate();
  unsafe.marketSafety.sellSimulationOk = false;
  assert.equal(shadowRuleMatches(unsafe, {
    signal: "escape-velocity", maxDeviationPct: 5,
  }), false);
});

test("records and resolves strategy samples without opening real positions", () => {
  const evaluator = new ShadowEvaluator({ horizonMs: 100 });
  evaluator.observe([candidate()], 1000);
  evaluator.observe([candidate("escape-velocity", 3)], 1100);
  const result = evaluator.snapshot();
  assert.equal(result.byRule["escape-strict"].closedSamples, 1);
  assert.equal(result.byRule["escape-strict"].averageReturnPct, 48);
  assert.equal(result.byRule["escape-relaxed"].closedSamples, 1);
});

test("keeps one unresolved sample per rule and pool", () => {
  const evaluator = new ShadowEvaluator({ horizonMs: 100 });
  evaluator.observe([candidate()], 1000);
  evaluator.observe([candidate()], 1050);
  assert.equal(evaluator.serialize().samples.length, 4);
});

test("promotion remains advisory until enough samples exist", () => {
  const result = evaluateShadowPromotion({
    closedSamples: 12, averageReturnPct: 10, medianReturnPct: 5,
    winRatePct: 60, maxCumulativeDrawdownPct: 5,
  });
  assert.equal(result.status, "collecting");
  assert.equal(result.remainingSamples, 18);
});

test("promotion requires robust return and drawdown evidence", () => {
  const promoted = evaluateShadowPromotion({
    closedSamples: 30, averageReturnPct: 3, medianReturnPct: 1,
    winRatePct: 50, maxCumulativeDrawdownPct: 20,
  });
  assert.equal(promoted.status, "promotion-candidate");
  assert.equal(promoted.eligible, true);

  const rejected = evaluateShadowPromotion({
    closedSamples: 30, averageReturnPct: 1, medianReturnPct: -1,
    winRatePct: 40, maxCumulativeDrawdownPct: 30,
  });
  assert.equal(rejected.status, "rejected");
  assert.deepEqual(rejected.failures, [
    "average-return-too-low", "median-return-too-low",
    "win-rate-too-low", "shadow-drawdown-too-high",
  ]);
});

test("resolves a pending pool after it drops from the ranked candidates", () => {
  const evaluator = new ShadowEvaluator({ horizonMs: 100 });
  evaluator.record([candidate()], 1000);
  assert.deepEqual(evaluator.pendingPoolAddresses(), ["0xpool"]);
  evaluator.resolve([{
    address: "0xpool", marketSafety: { tokenPriceQuote: 1 },
  }], 1100);
  assert.equal(evaluator.snapshot().byRule["escape-strict"].averageReturnPct, -52);
  assert.deepEqual(evaluator.pendingPoolAddresses(), []);
});

test("promotion metrics use net return after simulated execution cost", () => {
  const evaluator = new ShadowEvaluator({ horizonMs: 100 });
  evaluator.record([candidate("escape-velocity", 2)], 1000);
  evaluator.resolve([{
    address: "0xpool", marketSafety: { tokenPriceQuote: 2.1 },
  }], 1100);
  const sample = evaluator.serialize().samples[0];
  assert.ok(Math.abs(sample.grossReturnPct - 5) < 1e-9);
  assert.ok(Math.abs(sample.netReturnPct - 3) < 1e-9);
  assert.ok(Math.abs(evaluator.snapshot().byRule["escape-strict"].averageReturnPct - 3) < 1e-9);
});

test("unpriceable samples become conservative losses after three horizons", () => {
  const evaluator = new ShadowEvaluator({ horizonMs: 100 });
  evaluator.record([candidate()], 1000);
  evaluator.resolve([], 1299);
  assert.equal(evaluator.pendingPoolAddresses().length, 1);
  evaluator.resolve([], 1300);
  const summary = evaluator.snapshot().byRule["escape-strict"];
  assert.equal(summary.resolutionFailures, 1);
  assert.equal(summary.averageReturnPct, -100);
  assert.deepEqual(evaluator.pendingPoolAddresses(), []);
});

test("default evaluator records one, five and fifteen minute horizons", () => {
  const evaluator = new ShadowEvaluator();
  evaluator.record([candidate()], 1000);
  const horizons = [...new Set(evaluator.serialize().samples
    .filter((sample) => sample.rule === "escape-strict")
    .map((sample) => sample.horizonMs))];
  assert.deepEqual(horizons, [60_000, 300_000, 900_000]);
  assert.deepEqual(evaluator.snapshot().horizonsMs, horizons);
});

test("each horizon resolves only when its own observation period elapses", () => {
  const evaluator = new ShadowEvaluator({ horizonsMs: [100, 300] });
  evaluator.record([candidate()], 1000);
  evaluator.resolve([candidate("escape-velocity", 3)], 1100);
  const samples = evaluator.serialize().samples
    .filter((sample) => sample.rule === "escape-strict");
  assert.equal(samples.find((sample) => sample.horizonMs === 100).closedAt, 1100);
  assert.equal(samples.find((sample) => sample.horizonMs === 300).closedAt, undefined);
});

test("restoring legacy state preserves samples without replacing configured horizons", () => {
  const evaluator = new ShadowEvaluator();
  evaluator.restore({
    horizonMs: 300_000,
    horizonsMs: [300_000],
    samples: [{ rule: "escape-strict", pool: "0xold", openedAt: 1, entryPrice: 2 }],
  });
  assert.deepEqual(evaluator.snapshot().horizonsMs, [60_000, 300_000, 900_000]);
  assert.equal(evaluator.serialize().samples[0].horizonMs, 300_000);
});

test("confirmed timing rule requires two consecutive qualifying cycles", () => {
  const evaluator = new ShadowEvaluator({ horizonMs: 100 });
  evaluator.record([candidate()], 1000);
  assert.equal(evaluator.serialize().samples
    .filter((sample) => sample.rule === "escape-confirmed").length, 0);
  evaluator.record([candidate()], 1050);
  assert.equal(evaluator.serialize().samples
    .filter((sample) => sample.rule === "escape-confirmed").length, 1);
});

test("confirmed timing streak resets when the signal disappears", () => {
  const evaluator = new ShadowEvaluator({ horizonMs: 100 });
  evaluator.record([candidate()], 1000);
  evaluator.record([], 1050);
  evaluator.record([candidate()], 1100);
  assert.equal(evaluator.serialize().samples
    .filter((sample) => sample.rule === "escape-confirmed").length, 0);
});

test("steady accumulation is independent of escape velocity", () => {
  const evaluator = new ShadowEvaluator({ horizonMs: 100 });
  const steady = candidate("active");
  steady.signal.swapsCurrentWindow = 5;
  steady.signal.acceleration = 1.2;
  evaluator.record([steady], 1000);
  assert.equal(evaluator.serialize().samples
    .filter((sample) => sample.rule === "steady-accumulation").length, 1);
  assert.equal(evaluator.serialize().samples
    .filter((sample) => sample.rule === "escape-strict").length, 0);
});

test("steady accumulation rejects sparse or rapidly accelerating flow", () => {
  const rule = {
    signal: "active", minSwaps: 4, minAcceleration: 0.75,
    maxAcceleration: 1.5, maxDeviationPct: 5,
  };
  const sparse = candidate("active");
  sparse.signal.swapsCurrentWindow = 3;
  sparse.signal.acceleration = 1;
  assert.equal(shadowRuleMatches(sparse, rule), false);
  const spiking = candidate("active");
  spiking.signal.swapsCurrentWindow = 5;
  spiking.signal.acceleration = 1.8;
  assert.equal(shadowRuleMatches(spiking, rule), false);
});
