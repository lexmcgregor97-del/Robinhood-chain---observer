import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PAPER_POLICY, evaluateRiskGate } from "./risk-gate.js";

const measuredSafety = {
  quoteTokenKnown: true,
  liquidityKnown: true,
  buyMathOk: true,
  sellMathOk: true,
  priceAuditAvailable: true,
  spotVsLastSwapPct: 1,
  poolAgeMs: 10 * 60_000,
  priceImpactPct: 2,
  executionCostPct: 6,
};

test("fails closed when safety data is unavailable", () => {
  const result = evaluateRiskGate({ signal: { state: "escape-velocity" } });
  assert.equal(result.eligibleForPaperEntry, false);
  assert.ok(result.failures.includes("sell-math-failed"));
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

test("allows a bounded promoted steady-accumulation policy", () => {
  const policy = {
    ...DEFAULT_PAPER_POLICY,
    allowedSignals: ["active"],
    minSwaps: 4,
    minAcceleration: 0.75,
    maxAcceleration: 1.5,
  };
  const result = evaluateRiskGate({
    signal: { state: "active", swapsCurrentWindow: 5, acceleration: 1.1 },
    marketSafety: measuredSafety,
  }, policy);
  assert.equal(result.eligibleForPaperEntry, true);
  assert.deepEqual(result.failures, []);
  assert.ok(evaluateRiskGate({
    signal: { state: "active", swapsCurrentWindow: 3, acceleration: 1.1 },
    marketSafety: measuredSafety,
  }, policy).failures.includes("signal-activity-too-low"));
  assert.ok(evaluateRiskGate({
    signal: { state: "active", swapsCurrentWindow: 5, acceleration: 2 },
    marketSafety: measuredSafety,
  }, policy).failures.includes("signal-acceleration-too-high"));
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

test("live policy fails closed without independent sell evidence", () => {
  const candidate = {
    signal: { state: "escape-velocity" }, marketSafety: measuredSafety,
  };
  const policy = { ...DEFAULT_PAPER_POLICY, requireSellProbe: true };
  assert.ok(evaluateRiskGate(candidate, policy).failures.includes("sell-probe-required"));
  assert.equal(evaluateRiskGate({
    ...candidate, marketSafety: { ...measuredSafety, sellProbe: { passed: true } },
  }, policy).eligibleForPaperEntry, true);
});
