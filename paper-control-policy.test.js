import test from "node:test";
import assert from "node:assert/strict";
import {
  PAPER_CONTROL_RISK_POLICY,
  PAPER_CONTROL_STRATEGY,
} from "./paper-control-policy.js";

test("canonical control policy preserves the active v7 cohort parameters", () => {
  assert.equal(PAPER_CONTROL_STRATEGY.entryCashPct, 5);
  assert.equal(PAPER_CONTROL_STRATEGY.maxHoldMs, 30 * 60_000);
  assert.deepEqual(PAPER_CONTROL_RISK_POLICY.allowedSignals, ["active"]);
  assert.equal(PAPER_CONTROL_RISK_POLICY.minSwaps, 4);
  assert.equal(PAPER_CONTROL_RISK_POLICY.minAcceleration, 0.75);
  assert.equal(PAPER_CONTROL_RISK_POLICY.maxAcceleration, 1.5);
  assert.equal(PAPER_CONTROL_RISK_POLICY.maxPriceImpactPct, 1.5);
  assert.equal(PAPER_CONTROL_RISK_POLICY.maxExecutionCostPct, 4);
  assert.equal(PAPER_CONTROL_RISK_POLICY.requireSellProbe, true);
});
