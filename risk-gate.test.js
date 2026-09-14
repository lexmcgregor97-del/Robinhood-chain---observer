import test from "node:test";
import assert from "node:assert/strict";
import { evaluateRiskGate } from "./risk-gate.js";

const measuredSafety = {
  quoteTokenKnown: true,
  liquidityKnown: true,
  buySimulationOk: true,
  sellSimulationOk: true,
  priceAuditAvailable: true,
  spotVsLastSwapPct: 1,
  poolAgeMs: 10 * 60_000,
  priceImpactPct: 2,
  executionCostPct: 6,
};

test("fails closed when safety data is unavailable", () => {
  const result = evaluateRiskGate({ signal: { state: "escape-velocity" } });
  assert.equal(result.eligibleForPaperEntry, false);
  assert.ok(result.failures.includes("sell-simulation-failed"));
  assert.ok(result.failures.includes("liquidity-not-measured"));
});

test("allows a fully measured paper candidate", () => {
  const result = evaluateRiskGate({
    signal: { state: "escape-velocity" },
    marketSafety: measuredSafety,
  });
  assert.equal(result.eligibleForPaperEntry, true);
  assert.deepEqual(result.failures, []);
});

test("measures minimum pool age in wall-clock time", () => {
  const result = evaluateRiskGate({
    signal: { state: "escape-velocity" },
    marketSafety: { ...measuredSafety, poolAgeMs: 4 * 60_000 },
  });
  assert.ok(result.failures.includes("pool-too-new"));
});

test("blocks excessive execution cost", () => {
  const result = evaluateRiskGate({
    signal: { state: "escape-velocity" },
    marketSafety: { ...measuredSafety, executionCostPct: 30 },
  });
  assert.ok(result.failures.includes("execution-cost-too-high"));
});

test("V3 candidates fail closed until tick boundaries are measured", () => {
  const result = evaluateRiskGate({
    version: "v3",
    signal: { state: "escape-velocity" },
    marketSafety: { ...measuredSafety, tickBoundaryKnown: false },
  });
  assert.equal(result.eligibleForPaperEntry, false);
  assert.ok(result.failures.includes("v3-tick-boundary-unmeasured"));
});

test("blocks weak signals and dislocated spot prices", () => {
  const result = evaluateRiskGate({
    signal: { state: "breakout-watch" },
    marketSafety: { ...measuredSafety, spotVsLastSwapPct: 9 },
  });
  assert.equal(result.eligibleForPaperEntry, false);
  assert.ok(result.failures.includes("signal-not-ready"));
  assert.ok(result.failures.includes("spot-swap-price-dislocation"));
});
