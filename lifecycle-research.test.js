import test from "node:test";
import assert from "node:assert/strict";
import {
  assessStrategyEvidence,
  lifecycleCounterfactualMatrix,
  simulateLifecycleCounterfactual,
  summarizeLifecycleAudit,
} from "./lifecycle-research.js";

const marks = [0, -10, -18, 5, 25, 11].map((returnPct, at) => ({ returnPct, at }));

test("counterfactuals preserve the first observed threshold crossing", () => {
  assert.deepEqual(simulateLifecycleCounterfactual(marks, { stopPct: 15 }), {
    exitReturnPct: -18, reason: "stop-15", markAt: 2,
  });
  assert.deepEqual(simulateLifecycleCounterfactual(marks, {
    trailingActivationPct: 20, trailingDrawdownPct: 12,
  }), { exitReturnPct: 11, reason: "trailing-exit", markAt: 5 });
  assert.equal(lifecycleCounterfactualMatrix(marks)["take-profit-20"].exitReturnPct, 25);
});

test("outlier robustness identifies an edge carried by one winner", () => {
  const evidence = assessStrategyEvidence([
    { returnPct: 100 }, { returnPct: -5 }, { returnPct: -5 }, { returnPct: -5 },
    { returnPct: -5 }, { returnPct: -5 },
  ], { removeBestTrades: 1 });
  assert.equal(evidence.all.averageReturnPct, 12.5);
  assert.equal(evidence.withoutBest.averageReturnPct, -5);
  assert.equal(evidence.outlierDependence, true);
  assert.equal(assessStrategyEvidence([
    { returnPct: 10 }, { returnPct: -1 },
  ], { removeBestTrades: 2 }).outlierDependence, "insufficient-sample");
});

test("counterfactual precedence is conservative and first-mark peaks activate trails", () => {
  assert.deepEqual(simulateLifecycleCounterfactual([
    { returnPct: 25, at: 1 }, { returnPct: -10, at: 2 },
  ], { stopPct: 8, trailingActivationPct: 20, trailingDrawdownPct: 12 }), {
    exitReturnPct: -10, reason: "stop-8", markAt: 2,
  });
  assert.deepEqual(simulateLifecycleCounterfactual([
    { returnPct: 25, at: 1 }, { returnPct: 12, at: 2 },
  ], { trailingActivationPct: 20, trailingDrawdownPct: 12 }), {
    exitReturnPct: 12, reason: "trailing-exit", markAt: 2,
  });
});

test("lifecycle audit reports frozen boundaries and trail cadence", () => {
  assert.deepEqual(summarizeLifecycleAudit([
    { type: "close", entryAdverseBoundaryPct: 20, appliedBoundaryPct: 20,
      audit: { observedMarkIntervalMs: 13_000 } },
    { type: "close", entryAdverseBoundaryPct: 30, appliedBoundaryPct: null, audit: {} },
  ]), {
    entryBoundaryDistribution: { 20: 1, 30: 1 },
    appliedBoundaryDistribution: { 20: 1, unrecorded: 1 },
    trailExitCadenceMs: { samples: 1, average: 13_000 },
  });
});

test("malformed research input fails closed", () => {
  assert.throws(() => simulateLifecycleCounterfactual([], {}),
    /invalid-counterfactual-marks/);
  assert.throws(() => assessStrategyEvidence([{ returnPct: NaN }]),
    /invalid-strategy-records/);
  assert.throws(() => assessStrategyEvidence([], { removeBestTrades: -1 }),
    /invalid-strategy-evidence-policy/);
});
