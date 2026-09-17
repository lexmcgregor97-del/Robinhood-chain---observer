import test from "node:test";
import assert from "node:assert/strict";
import {
  PAPER_FREQUENCY_CANDIDATE_HYPOTHESIS,
  PAPER_FREQUENCY_CANDIDATE_RISK_POLICY,
  PAPER_FREQUENCY_CANDIDATE_STRATEGY,
} from "./paper-frequency-candidate.js";
import { evaluateRiskGate } from "./risk-gate.js";

test("frequency candidate relaxes opportunity gates without relaxing safety", () => {
  assert.deepEqual(PAPER_FREQUENCY_CANDIDATE_RISK_POLICY.allowedSignals,
    ["active", "breakout-watch"]);
  assert.equal(PAPER_FREQUENCY_CANDIDATE_RISK_POLICY.minSwaps, 3);
  assert.equal(PAPER_FREQUENCY_CANDIDATE_RISK_POLICY.minAcceleration, 0.6);
  assert.equal(PAPER_FREQUENCY_CANDIDATE_RISK_POLICY.maxAcceleration, 3);
  assert.equal(PAPER_FREQUENCY_CANDIDATE_RISK_POLICY.maxPriceImpactPct, 1.5);
  assert.equal(PAPER_FREQUENCY_CANDIDATE_RISK_POLICY.maxExecutionCostPct, 4);
  assert.equal(PAPER_FREQUENCY_CANDIDATE_RISK_POLICY.maxSpotSwapDeviationPct, 5);
  assert.equal(PAPER_FREQUENCY_CANDIDATE_RISK_POLICY.requireGasEstimate, true);
  assert.equal(PAPER_FREQUENCY_CANDIDATE_RISK_POLICY.requireSellProbe, true);
  assert.equal(PAPER_FREQUENCY_CANDIDATE_STRATEGY.entryCashPct, 5);
  assert.equal(PAPER_FREQUENCY_CANDIDATE_STRATEGY.maxEntriesPerPool, 3);
  assert.equal(PAPER_FREQUENCY_CANDIDATE_STRATEGY.entryWindowMs, 6 * 60 * 60_000);
  assert.equal(PAPER_FREQUENCY_CANDIDATE_STRATEGY.maxRealizedDrawdownPct, 10);
  assert.equal(PAPER_FREQUENCY_CANDIDATE_HYPOTHESIS.finishLine.promotionAutomatic, false);
});

test("frequency candidate admits bounded breakout activity and still fails unsafe markets", () => {
  const candidate = {
    version: "v2",
    signal: { state: "breakout-watch", swapsCurrentWindow: 3, acceleration: 2.5 },
    marketSafety: {
      quoteTokenKnown: true,
      liquidityKnown: true,
      buyMathOk: true,
      sellMathOk: true,
      gasEstimateAvailable: true,
      sellProbe: { passed: true },
      priceAuditAvailable: true,
      spotVsLastSwapPct: 1,
      poolAgeMs: 6 * 60_000,
      priceImpactPct: 1,
      executionCostPct: 3,
    },
  };
  assert.equal(evaluateRiskGate(
    candidate, PAPER_FREQUENCY_CANDIDATE_RISK_POLICY,
  ).eligibleForPaperEntry, true);
  assert.deepEqual(evaluateRiskGate({
    ...candidate,
    marketSafety: { ...candidate.marketSafety, sellProbe: { passed: false } },
  }, PAPER_FREQUENCY_CANDIDATE_RISK_POLICY).failures, ["sell-probe-required"]);
  assert.ok(evaluateRiskGate({
    ...candidate,
    signal: { state: "escape-velocity", swapsCurrentWindow: 6, acceleration: 3 },
  }, PAPER_FREQUENCY_CANDIDATE_RISK_POLICY).failures.includes("signal-not-ready"));
});
