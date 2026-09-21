import test from "node:test";
import assert from "node:assert/strict";
import {
  PAPER_OPPORTUNITY_CANDIDATE_HYPOTHESIS,
  PAPER_OPPORTUNITY_CANDIDATE_RISK_POLICY,
  PAPER_OPPORTUNITY_CANDIDATE_STRATEGY,
  PAPER_OPPORTUNITY_CANDIDATE_VERSION,
} from "./paper-opportunity-candidate.js";
import { PAPER_LIFECYCLE_CANDIDATE_STRATEGY } from "./paper-lifecycle-candidate.js";

test("opportunity cohort broadens momentum discovery without weakening safety", () => {
  assert.equal(PAPER_OPPORTUNITY_CANDIDATE_VERSION, "2026-09-21-paper-opportunity-v1");
  assert.deepEqual(PAPER_OPPORTUNITY_CANDIDATE_RISK_POLICY.allowedSignals,
    ["active", "breakout-watch", "escape-velocity"]);
  assert.equal(PAPER_OPPORTUNITY_CANDIDATE_RISK_POLICY.minSwaps, 3);
  assert.equal(PAPER_OPPORTUNITY_CANDIDATE_RISK_POLICY.minAcceleration, 0.6);
  assert.equal(PAPER_OPPORTUNITY_CANDIDATE_RISK_POLICY.maxAcceleration, 12);
  assert.equal(PAPER_OPPORTUNITY_CANDIDATE_RISK_POLICY.requireSellProbe, true);
  assert.equal(PAPER_OPPORTUNITY_CANDIDATE_RISK_POLICY.requireGasEstimate, true);
  assert.equal(PAPER_OPPORTUNITY_CANDIDATE_RISK_POLICY.maxPriceImpactPct, 1.5);
  assert.equal(PAPER_OPPORTUNITY_CANDIDATE_RISK_POLICY.maxExecutionCostPct, 4);
});

test("opportunity cohort preserves lifecycle exits and paper-only boundary", () => {
  for (const [field, value] of Object.entries(PAPER_LIFECYCLE_CANDIDATE_STRATEGY)) {
    assert.equal(PAPER_OPPORTUNITY_CANDIDATE_STRATEGY[field], value);
  }
  assert.equal(PAPER_OPPORTUNITY_CANDIDATE_STRATEGY.entryWindowMs, 6 * 60 * 60_000);
  assert.equal(PAPER_OPPORTUNITY_CANDIDATE_HYPOTHESIS.activation.runtimeEnabled, true);
  assert.equal(PAPER_OPPORTUNITY_CANDIDATE_HYPOTHESIS.activation.isolatedPaperCohort, true);
  assert.equal(PAPER_OPPORTUNITY_CANDIDATE_HYPOTHESIS.activation.automaticPromotion, false);
  assert.equal(PAPER_OPPORTUNITY_CANDIDATE_HYPOTHESIS.activation.liveExecutionSupported, false);
  assert.ok(PAPER_OPPORTUNITY_CANDIDATE_HYPOTHESIS.preserved
    .includes("v2-only-until-exact-v3-sell-proof-exists"));
});

test("opportunity policy objects are immutable", () => {
  assert.equal(Object.isFrozen(PAPER_OPPORTUNITY_CANDIDATE_RISK_POLICY), true);
  assert.equal(Object.isFrozen(PAPER_OPPORTUNITY_CANDIDATE_RISK_POLICY.allowedSignals), true);
  assert.equal(Object.isFrozen(PAPER_OPPORTUNITY_CANDIDATE_STRATEGY), true);
  assert.equal(Object.isFrozen(PAPER_OPPORTUNITY_CANDIDATE_HYPOTHESIS), true);
});
