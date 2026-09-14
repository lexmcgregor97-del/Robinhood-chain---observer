import test from "node:test";
import assert from "node:assert/strict";
import { evaluateRiskGate } from "./risk-gate.js";

test("fails closed when safety data is unavailable", () => {
  const result = evaluateRiskGate({ signal: { state: "escape-velocity" } });
  assert.equal(result.eligibleForPaperEntry, false);
  assert.ok(result.failures.includes("sell-simulation-failed"));
  assert.ok(result.failures.includes("liquidity-not-measured"));
});

test("allows a fully measured paper candidate", () => {
  const result = evaluateRiskGate({
    signal: { state: "escape-velocity" },
    marketSafety: { quoteTokenKnown: true, liquidityKnown: true, buySimulationOk: true,
      sellSimulationOk: true, priceAuditAvailable: true, spotVsLastSwapPct: 1,
      poolAgeBlocks: 50, priceImpactPct: 2, roundTripLossPct: 6 },
  });
  assert.equal(result.eligibleForPaperEntry, true);
  assert.deepEqual(result.failures, []);
});

test("blocks excessive execution loss", () => {
  const result = evaluateRiskGate({
    signal: { state: "escape-velocity" },
    marketSafety: { quoteTokenKnown: true, liquidityKnown: true, buySimulationOk: true,
      sellSimulationOk: true, poolAgeBlocks: 50, priceImpactPct: 2, roundTripLossPct: 30 },
  });
  assert.ok(result.failures.includes("round-trip-loss-too-high"));
});


test("V3 candidates fail closed until tick boundaries are measured", () => {
  const result = evaluateRiskGate({
    version: "v3", signal: { state: "escape-velocity" }, marketSafety: {
      quoteTokenKnown: true, liquidityKnown: true, buySimulationOk: true, sellSimulationOk: true,
      poolAgeBlocks: 100, priceImpactPct: 1, roundTripLossPct: 1, tickBoundaryKnown: false,
    },
  });
  assert.equal(result.eligibleForPaperEntry, false);
  assert.ok(result.failures.includes("v3-tick-boundary-unmeasured"));
});

test("blocks weak signals and dislocated spot prices", () => {
  const base = {
    marketSafety: {
      quoteTokenKnown: true, liquidityKnown: true, buySimulationOk: true,
      sellSimulationOk: true, priceAuditAvailable: true, spotVsLastSwapPct: 9,
      poolAgeBlocks: 50, priceImpactPct: 1, roundTripLossPct: 2,
    },
  };
  const result = evaluateRiskGate({
    ...base, signal: { state: "breakout-watch" },
  });
  assert.equal(result.eligibleForPaperEntry, false);
  assert.ok(result.failures.includes("signal-not-ready"));
  assert.ok(result.failures.includes("spot-swap-price-dislocation"));
});
