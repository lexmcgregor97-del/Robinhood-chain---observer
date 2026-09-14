import test from "node:test";
import assert from "node:assert/strict";
import { ShadowEvaluator, shadowRuleMatches } from "./shadow-evaluator.js";

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
  assert.equal(result.byRule["escape-strict"].averageReturnPct, 50);
  assert.equal(result.byRule["escape-relaxed"].closedSamples, 1);
});

test("keeps one unresolved sample per rule and pool", () => {
  const evaluator = new ShadowEvaluator({ horizonMs: 100 });
  evaluator.observe([candidate()], 1000);
  evaluator.observe([candidate()], 1050);
  assert.equal(evaluator.serialize().samples.length, 2);
});
