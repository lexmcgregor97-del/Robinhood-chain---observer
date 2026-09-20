import test from "node:test";
import assert from "node:assert/strict";
import {
  EPOCH_EVALUATOR_BOUNDARY,
  FROZEN_RESEARCH_QUALIFICATION_POLICY,
  evaluateResearchEpoch,
} from "./epoch-evaluator.js";

const record = (index, overrides = {}) => ({
  episodeId: `episode-${index}`,
  closedAt: index,
  pool: `pool-${index % 50}`,
  returnPct: index % 2 ? -1 : 4,
  portfolioPnl: index % 2 ? -0.02 : 0.08,
  gasCostPct: 0.1,
  regime: index % 4 < 2 ? "broad-expansion" : "rotational-chop",
  measurementFailure: false,
  lifecycleComplete: true,
  entryCashPct: 2,
  entryAdverseBoundaryPct: 20,
  appliedBoundaryPct: null,
  declaredRiskBudgetPct: 0.4,
  ...overrides,
});

const healthy = () => Array.from({ length: 100 }, (_, index) => record(index));

test("qualifies a diversified cost-stressed paper research sample", () => {
  const result = evaluateResearchEpoch({ records: healthy(), initialCash: 100 });
  assert.equal(result.status, "paper-research-qualified");
  assert.equal(result.automaticPromotion, false);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.performance.profitFactor, 4);
  assert.ok(result.stress.expectancyPct > 0);
  assert.equal(result.regimes.sufficientlySampled, 2);
  assert.equal(result.integrity.riskBudgetBreaches, 0);
  assert.equal(result.policy.minimumClosedTrades, 100);
  assert.equal(evaluateResearchEpoch({
    records: healthy().reverse(), initialCash: 100,
  }).performance.maximumPortfolioDrawdownPct,
  result.performance.maximumPortfolioDrawdownPct);
});

test("sample sufficiency blocks conclusions before edge metrics can promote", () => {
  const result = evaluateResearchEpoch({ records: healthy().slice(0, 20), initialCash: 100 });
  assert.equal(result.status, "insufficient-sample");
  assert.ok(result.blockers.includes("insufficient-trades"));
  assert.ok(result.blockers.includes("insufficient-unique-pools"));
});

test("integrity failures outrank apparent profitability", () => {
  const records = healthy();
  records[1] = record(1, { episodeId: "episode-0" });
  records[2] = record(2, { entryCashPct: 3 });
  records[3] = record(3, { measurementFailure: true });
  const result = evaluateResearchEpoch({
    records, initialCash: 100, orphanedPartialCloses: 1,
  });
  assert.equal(result.status, "invalid-evidence");
  assert.ok(result.blockers.includes("duplicate-episodes"));
  assert.ok(result.blockers.includes("measurement-failures"));
  assert.ok(result.blockers.includes("risk-budget-breaches"));
  assert.ok(result.blockers.includes("orphaned-partial-closes"));
});

test("all-winning evidence makes the missing profit-factor denominator explicit", () => {
  const records = healthy().map((item) => ({
    ...item, returnPct: 2, portfolioPnl: 0.02,
  }));
  const result = evaluateResearchEpoch({ records, initialCash: 100 });
  assert.equal(result.performance.profitFactor, null);
  assert.equal(result.performance.profitFactorDefined, false);
  assert.equal(result.performance.profitFactorReason, "undefined-no-losses");
  assert.equal(result.blockers.includes("profit-factor-below-threshold"), false);
  assert.deepEqual(result.qualificationCaveats, ["profit-factor-undefined-no-losses"]);
  assert.equal(result.status, "paper-research-qualified");
});

test("duplicate episodes are invalid and wholly excluded from analytics", () => {
  const records = healthy();
  records.push(record(100, {
    episodeId: "episode-0", returnPct: 10_000, portfolioPnl: 10_000,
  }));
  const result = evaluateResearchEpoch({ records, initialCash: 100 });
  assert.equal(result.status, "invalid-evidence");
  assert.equal(result.integrity.inputRecords, 101);
  assert.equal(result.integrity.validRecords, 101);
  assert.equal(result.integrity.analyzedRecords, 99);
  assert.equal(result.integrity.duplicateEpisodes, 1);
  assert.equal(result.performance.trades, 99);
  assert.equal(result.performance.derivedFromInvalidEvidence, true);
  assert.ok(result.blockers.includes("duplicate-episodes"));
});

test("duplicated episodes cannot hide measurement or risk-budget failures", () => {
  for (const [overrides, counter, blocker] of [
    [{ measurementFailure: true }, "measurementFailures", "measurement-failures"],
    [{ appliedBoundaryPct: 30 }, "riskBudgetBreaches", "risk-budget-breaches"],
  ]) {
    const records = healthy();
    records[0] = record(0, overrides);
    records.push(record(100, { episodeId: "episode-0" }));
    const result = evaluateResearchEpoch({ records, initialCash: 100 });
    assert.equal(result.integrity[counter], 1, counter);
    assert.ok(result.blockers.includes("duplicate-episodes"));
    assert.ok(result.blockers.includes(blocker), blocker);
  }
});

test("regime coverage uses analyzed records rather than ambiguous episodes", () => {
  const records = Array.from({ length: 100 }, (_, index) => record(index, {
    regime: "broad-expansion",
  }));
  records.push(record(100, {
    episodeId: "ambiguous-regime", regime: "rotational-chop",
  }));
  records.push(record(101, {
    episodeId: "ambiguous-regime", regime: "rotational-chop",
  }));
  const result = evaluateResearchEpoch({ records, initialCash: 100 });
  assert.equal(result.integrity.validRecords, 102);
  assert.equal(result.integrity.analyzedRecords, 100);
  assert.equal(result.regimes.sufficientlySampled, 1);
  assert.ok(result.blockers.includes("insufficient-regime-coverage"));
});

test("sample sufficiency uses analyzed count at the exact boundary", () => {
  const records = healthy();
  records.push(record(100, { episodeId: "ambiguous-extra" }));
  records.push(record(101, { episodeId: "ambiguous-extra" }));
  const result = evaluateResearchEpoch({ records, initialCash: 100 });
  assert.equal(result.integrity.validRecords, 102);
  assert.equal(result.integrity.analyzedRecords, 100);
  assert.equal(result.status, "invalid-evidence");
  assert.equal(result.blockers.includes("insufficient-trades"), false);
  assert.ok(result.blockers.includes("duplicate-episodes"));
});

test("removing the largest winners exposes outlier-dependent results", () => {
  const records = healthy().map((item, index) => ({
    ...item,
    returnPct: index < 3 ? 100 : -1,
    portfolioPnl: index < 3 ? 1 : -0.01,
  }));
  const result = evaluateResearchEpoch({ records, initialCash: 100 });
  assert.equal(result.status, "outlier-dependent");
  assert.equal(result.outlierTest.outlierDependent, true);
});

test("regime dependence is distinguished from general edge failure", () => {
  const records = healthy().map((item) => item.regime === "rotational-chop"
    ? { ...item, returnPct: -2, portfolioPnl: -0.02 }
    : { ...item, returnPct: 6, portfolioPnl: 0.06 });
  const result = evaluateResearchEpoch({ records, initialCash: 100 });
  assert.equal(result.status, "regime-dependent");
  assert.equal(result.regimes.profitableSampled, 1);
});

test("pessimistic costs can reject an otherwise positive raw expectancy", () => {
  const records = healthy().map((item, index) => ({
    ...item,
    returnPct: index % 2 ? -1 : 1.5,
    portfolioPnl: index % 2 ? -0.01 : 0.015,
    gasCostPct: 0.2,
  }));
  const result = evaluateResearchEpoch({ records, initialCash: 100 });
  assert.ok(result.performance.expectancyPct > 0);
  assert.ok(result.stress.expectancyPct <= 0);
  assert.equal(result.status, "edge-not-demonstrated");
  assert.ok(result.blockers.includes("stress-expectancy-non-positive"));
});

test("malformed records are retained as invalid evidence rather than dropped silently", () => {
  const records = healthy();
  records.push({ episodeId: "broken" });
  const result = evaluateResearchEpoch({ records, initialCash: 100 });
  assert.equal(result.status, "invalid-evidence");
  assert.equal(result.integrity.inputRecords, 101);
  assert.equal(result.integrity.malformedRecords, 1);
});

test("equal close timestamps have deterministic drawdown ordering", () => {
  const records = healthy().map((item) => ({ ...item, portfolioPnl: 0 }));
  records[0] = record(0, {
    episodeId: "episode-a", closedAt: 10, portfolioPnl: -10,
  });
  records[1] = record(1, {
    episodeId: "episode-b", closedAt: 10, portfolioPnl: 10,
  });
  const forward = evaluateResearchEpoch({ records, initialCash: 100 });
  const reversed = evaluateResearchEpoch({ records: [...records].reverse(), initialCash: 100 });
  assert.equal(forward.performance.maximumPortfolioDrawdownPct, 10);
  assert.equal(reversed.performance.maximumPortfolioDrawdownPct, 10);
});

test("null applied boundaries do not create risk-budget breaches", () => {
  const result = evaluateResearchEpoch({
    records: healthy().map((item) => ({ ...item, appliedBoundaryPct: null })),
    initialCash: 100,
  });
  assert.equal(result.integrity.riskBudgetBreaches, 0);
  assert.equal(result.blockers.includes("risk-budget-breaches"), false);
});

test("qualification thresholds are inclusive at exact equality", () => {
  const records = healthy().map((item, index) => ({
    ...item,
    pool: index < 20 ? "pool-0" : `pool-${1 + ((index - 20) % 29)}`,
    returnPct: index < 50 ? 1.3 : -1,
    portfolioPnl: index === 0 ? -10 : 0,
  }));
  const result = evaluateResearchEpoch({ records, initialCash: 100 });
  assert.equal(result.performance.trades, 100);
  assert.equal(result.performance.uniquePools, 30);
  assert.equal(result.performance.maximumPoolTradeConcentrationPct, 20);
  assert.equal(result.performance.maximumPortfolioDrawdownPct, 10);
  assert.equal(result.performance.profitFactor, 1.3);
  for (const blocker of [
    "insufficient-trades",
    "insufficient-unique-pools",
    "pool-concentration-above-threshold",
    "drawdown-above-threshold",
    "profit-factor-below-threshold",
  ]) assert.equal(result.blockers.includes(blocker), false, blocker);
});

test("policy and activation boundaries are frozen and fail closed", () => {
  assert.equal(FROZEN_RESEARCH_QUALIFICATION_POLICY.minimumClosedTrades, 100);
  assert.equal(FROZEN_RESEARCH_QUALIFICATION_POLICY.minimumProfitFactor, 1.3);
  assert.deepEqual(EPOCH_EVALUATOR_BOUNDARY, {
    runtimeEnabled: false,
    automaticPromotion: false,
    paperMutationSupported: false,
    liveExecutionSupported: false,
  });
  assert.throws(() => evaluateResearchEpoch({ records: [], initialCash: 0 }),
    /invalid-research-epoch-input/);
  assert.throws(() => evaluateResearchEpoch({
    records: [], initialCash: 100,
    policy: { ...FROZEN_RESEARCH_QUALIFICATION_POLICY, minimumClosedTrades: 0 },
  }), /invalid-research-qualification-policy/);
  assert.throws(() => evaluateResearchEpoch({
    records: [], initialCash: 100,
    policy: { ...FROZEN_RESEARCH_QUALIFICATION_POLICY,
      maximumPoolTradeConcentrationPct: 101 },
  }), /invalid-research-qualification-policy/);
});
