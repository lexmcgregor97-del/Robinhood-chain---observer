import test from "node:test";
import assert from "node:assert/strict";
import {
  MARKET_INTELLIGENCE_BOUNDARY,
  RELATIVE_STRENGTH_SCALES,
  classifyMarketRegime,
  planCapitalReplacement,
  rankRelativeStrength,
} from "./market-intelligence.js";

const candidate = (address, state, acceleration, score, cost, flow = {}) => ({
  address,
  signal: { state, acceleration, score, swapsCurrentWindow: state === "quiet" ? 0 : 4,
    adaptiveFlow: { buyShare: 0.5, volumeMultiple: 1, ...flow } },
  marketSafety: { executionCostPct: cost, sellMathOk: true },
});

test("classifies broad, concentrated, choppy, and unavailable markets", () => {
  const broad = Array.from({ length: 5 }, (_, index) => candidate(
    `0x${index}`, "breakout-watch", 2.5, 10, 1,
  ));
  assert.equal(classifyMarketRegime(broad).regime, "broad-expansion");
  const concentrated = [
    candidate("a", "breakout-watch", 2, 10, 1),
    candidate("b", "active", 1, 10, 1),
    candidate("c", "active", 1, 10, 1),
    candidate("d", "active", 1, 10, 1),
  ];
  assert.equal(classifyMarketRegime(concentrated).regime, "concentrated-expansion");
  const unavailable = classifyMarketRegime(concentrated.slice(0, 2));
  assert.equal(unavailable.regime, "unavailable");
  assert.equal(unavailable.coverageConfidence, 0.2);
  assert.equal(unavailable.separationMargin, null);
});

test("expansion evidence wins ambiguous acceleration and breadth ties", () => {
  const allExpandingSlow = Array.from({ length: 4 }, (_, index) => candidate(
    `slow-${index}`, "escape-velocity", 0.5, 10, 1,
  ));
  assert.equal(classifyMarketRegime(allExpandingSlow).regime, "broad-expansion");
  const mostlySilent = Array.from({ length: 7 }, (_, index) => candidate(
    `quiet-${index}`, "quiet", 3, 10, 1,
  ));
  mostlySilent.push(candidate("survivor", "active", 3, 10, 1));
  assert.notEqual(classifyMarketRegime(mostlySilent).regime, "contraction");
  const measured = classifyMarketRegime(Array.from({ length: 10 }, (_, index) => candidate(
    `neutral-${index}`, "active", 1, 10, 1,
  )));
  assert.equal(measured.coverageConfidence, 1);
  assert.equal(typeof measured.separationMargin, "number");
});

test("inactive stale states cannot manufacture broad expansion", () => {
  const mostlyInactive = Array.from({ length: 6 }, (_, index) => ({
    ...candidate(`stale-${index}`, "escape-velocity", 0.5, 10, 1),
    signal: {
      ...candidate(`stale-${index}`, "escape-velocity", 0.5, 10, 1).signal,
      swapsCurrentWindow: 0,
    },
  }));
  mostlyInactive.push(candidate("live", "escape-velocity", 0.5, 10, 1));
  assert.notEqual(classifyMarketRegime(mostlyInactive).regime, "broad-expansion");
});

test("chop separation uses the nearer expansion or contraction boundary", () => {
  const nearContraction = Array.from({ length: 8 }, (_, index) => candidate(
    `quiet-${index}`, "quiet", 0.5, 10, 1,
  ));
  nearContraction.push(candidate("active-a", "active", 0.5, 10, 1));
  nearContraction.push(candidate("active-b", "active", 0.5, 10, 1));
  const result = classifyMarketRegime(nearContraction);
  assert.equal(result.regime, "rotational-chop");
  assert.equal(result.separationMargin, 0.333);
});

test("relative strength rewards flow and penalizes execution cost", () => {
  const ranked = rankRelativeStrength([
    candidate("A", "active", 1.5, 30, 1, { buyShare: 0.7, volumeMultiple: 2 }),
    candidate("B", "active", 1.5, 30, 10, { buyShare: 0.4, volumeMultiple: 1 }),
  ]);
  assert.equal(ranked[0].address, "a");
  assert.equal(ranked[0].rank, 1);
  assert.ok(ranked[0].relativeStrengthScore > ranked[1].relativeStrengthScore);
});

test("relative-strength values remain comparable across candidate sets", () => {
  const target = candidate("target", "active", 0.2, 0.2, 1);
  const alone = rankRelativeStrength([target])[0].relativeStrengthScore;
  const amongStrong = rankRelativeStrength([
    target,
    ...Array.from({ length: 9 }, (_, index) => candidate(
      `strong-${index}`, "escape-velocity", 100, 100, 1,
    )),
  ]).find((item) => item.address === "target").relativeStrengthScore;
  assert.equal(alone, amongStrong);
  assert.ok(alone < 30);
});

test("relative-strength methodology constants are explicit and pinned", () => {
  assert.deepEqual(RELATIVE_STRENGTH_SCALES, {
    signalScore: 50, acceleration: 2, volumeMultiple: 2,
  });
});

test("replacement requires weak incumbent and a material net advantage", () => {
  assert.equal(planCapitalReplacement({
    incumbent: { relativeStrengthScore: 30, signalState: "healthy" },
    challenger: { relativeStrengthScore: 80, executable: true },
  }).replace, false);
  assert.deepEqual(planCapitalReplacement({
    incumbent: { relativeStrengthScore: 30, signalState: "weakening" },
    challenger: { relativeStrengthScore: 80, executable: true },
    estimatedRotationCostPct: 5,
  }), { replace: true, reason: "material-relative-strength-advantage", netAdvantage: 45 });
  assert.equal(planCapitalReplacement({
    incumbent: { relativeStrengthScore: 30 },
    challenger: { relativeStrengthScore: 80, executable: true },
  }).reason, "replacement-evidence-unavailable");
  assert.equal(planCapitalReplacement({
    incumbent: { relativeStrengthScore: 30, signalState: "invalidated" },
    challenger: { relativeStrengthScore: 80, executable: true },
  }).replace, true);
  assert.equal(planCapitalReplacement({
    incumbent: { relativeStrengthScore: 30, signalState: "mystery" },
    challenger: { relativeStrengthScore: 80, executable: true },
  }).replace, false);
});

test("market intelligence remains incapable of runtime action", () => {
  assert.deepEqual(MARKET_INTELLIGENCE_BOUNDARY, {
    runtimeEnabled: false, entryEligible: false,
    replacementEnabled: false, liveExecutionSupported: false,
  });
});
