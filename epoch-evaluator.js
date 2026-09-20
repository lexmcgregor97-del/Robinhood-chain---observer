const finite = (value) => typeof value === "number" && Number.isFinite(value);
const round = (value) => Math.round(value * 1_000_000) / 1_000_000;

export const EPOCH_EVALUATOR_VERSION = "2026-09-20-dormant-epoch-evaluator-v3";

export const FROZEN_RESEARCH_QUALIFICATION_POLICY = Object.freeze({
  minimumClosedTrades: 100,
  minimumUniquePools: 30,
  minimumRegimes: 2,
  minimumTradesPerRegime: 15,
  minimumProfitFactor: 1.3,
  minimumExpectancyPct: 0,
  maximumPortfolioDrawdownPct: 10,
  maximumPoolTradeConcentrationPct: 20,
  removeBestTrades: 3,
  minimumRemainingAfterOutlierRemoval: 25,
  additionalSlippagePctPerTrade: 1,
  gasCostMultiplier: 2,
  maximumMeasurementFailures: 0,
});

const KNOWN_REGIMES = new Set([
  "broad-expansion", "concentrated-expansion", "rotational-chop", "contraction",
]);

function summarizeReturns(values) {
  const wins = values.filter((value) => value > 0);
  const losses = values.filter((value) => value < 0);
  const grossProfit = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  const profitFactorDefined = grossLoss > 0;
  return {
    trades: values.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: values.length ? round(wins.length / values.length * 100) : 0,
    expectancyPct: values.length
      ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0,
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss)
      : (grossProfit > 0 ? null : 0),
    profitFactorDefined,
    profitFactorReason: profitFactorDefined ? "measured"
      : (grossProfit > 0 ? "undefined-no-losses" : "undefined-no-gains-or-losses"),
  };
}

function maxPortfolioDrawdownPct(records, initialCash) {
  let equity = initialCash;
  let peak = initialCash;
  let maximum = 0;
  for (const record of records) {
    equity += record.portfolioPnl;
    peak = Math.max(peak, equity);
    if (peak > 0) maximum = Math.max(maximum, (peak - equity) / peak * 100);
  }
  return round(maximum);
}

function validatePolicy(policy) {
  const positiveIntegers = [
    "minimumClosedTrades", "minimumUniquePools", "minimumRegimes",
    "minimumTradesPerRegime", "minimumRemainingAfterOutlierRemoval",
  ];
  const nonNegative = [
    "minimumExpectancyPct", "maximumPortfolioDrawdownPct",
    "maximumPoolTradeConcentrationPct", "removeBestTrades",
    "additionalSlippagePctPerTrade", "maximumMeasurementFailures",
  ];
  if (!policy || positiveIntegers.some((key) => !Number.isInteger(policy[key])
      || policy[key] <= 0)
      || nonNegative.some((key) => !finite(policy[key]) || policy[key] < 0)
      || !Number.isInteger(policy.removeBestTrades)
      || !Number.isInteger(policy.maximumMeasurementFailures)
      || policy.minimumRegimes > KNOWN_REGIMES.size
      || policy.maximumPortfolioDrawdownPct > 100
      || policy.maximumPoolTradeConcentrationPct > 100
      || !finite(policy.minimumProfitFactor) || policy.minimumProfitFactor <= 0
      || !finite(policy.gasCostMultiplier) || policy.gasCostMultiplier < 1) {
    throw new Error("invalid-research-qualification-policy");
  }
  return policy;
}

function validateRecord(record) {
  return typeof record?.episodeId === "string" && record.episodeId.length > 0
    && typeof record?.pool === "string" && record.pool.length > 0
    && finite(record.closedAt) && record.closedAt >= 0
    && finite(record.returnPct)
    && finite(record.portfolioPnl)
    && finite(record.gasCostPct) && record.gasCostPct >= 0
    && finite(record.entryCashPct) && record.entryCashPct > 0
    && finite(record.entryAdverseBoundaryPct) && record.entryAdverseBoundaryPct > 0
    && finite(record.declaredRiskBudgetPct) && record.declaredRiskBudgetPct > 0
    && (record.appliedBoundaryPct === null
      || (finite(record.appliedBoundaryPct) && record.appliedBoundaryPct > 0))
    && KNOWN_REGIMES.has(record.regime)
    && typeof record.measurementFailure === "boolean"
    && record.lifecycleComplete === true;
}

export function evaluateResearchEpoch({
  records,
  initialCash,
  orphanedPartialCloses = 0,
  policy = FROZEN_RESEARCH_QUALIFICATION_POLICY,
} = {}) {
  validatePolicy(policy);
  if (!Array.isArray(records) || !finite(initialCash) || initialCash <= 0
      || !Number.isInteger(orphanedPartialCloses) || orphanedPartialCloses < 0) {
    throw new Error("invalid-research-epoch-input");
  }
  const malformedRecords = records.filter((record) => !validateRecord(record)).length;
  const valid = records.filter(validateRecord);
  const episodeCounts = new Map();
  for (const record of valid) {
    episodeCounts.set(record.episodeId, Number(episodeCounts.get(record.episodeId) || 0) + 1);
  }
  const duplicateEpisodes = [...episodeCounts.values()]
    .reduce((count, occurrences) => count + Math.max(0, occurrences - 1), 0);
  // A repeated episode is ambiguous evidence. Exclude every occurrence of that
  // episode from analytics while retaining the duplicate as an integrity failure.
  const analyzed = valid.filter((record) => episodeCounts.get(record.episodeId) === 1);
  const returns = analyzed.map((record) => record.returnPct);
  const summary = summarizeReturns(returns);
  const stressedReturns = analyzed.map((record) => round(
    record.returnPct
      - policy.additionalSlippagePctPerTrade
      - record.gasCostPct * (policy.gasCostMultiplier - 1),
  ));
  const stressed = summarizeReturns(stressedReturns);
  const orderedReturns = [...returns].sort((a, b) => b - a);
  const withoutBestValues = orderedReturns.slice(
    Math.min(policy.removeBestTrades, orderedReturns.length),
  );
  const withoutBest = summarizeReturns(withoutBestValues);
  const outlierSampleSufficient = withoutBestValues.length
    >= policy.minimumRemainingAfterOutlierRemoval;

  const poolCounts = new Map();
  const regimeRecords = new Map();
  let measurementFailures = 0;
  let riskBudgetBreaches = 0;
  // Integrity defects belong to the validated evidence population, including
  // records later excluded from statistics because their episode is ambiguous.
  for (const record of valid) {
    if (record.measurementFailure) measurementFailures += 1;
    const entryRiskPct = record.entryCashPct * record.entryAdverseBoundaryPct / 100;
    if (entryRiskPct > record.declaredRiskBudgetPct + 1e-12
        || (record.appliedBoundaryPct !== null
          && record.appliedBoundaryPct > record.entryAdverseBoundaryPct)) {
      riskBudgetBreaches += 1;
    }
  }
  for (const record of analyzed) {
    const pool = record.pool.toLowerCase();
    poolCounts.set(pool, Number(poolCounts.get(pool) || 0) + 1);
    if (!regimeRecords.has(record.regime)) regimeRecords.set(record.regime, []);
    regimeRecords.get(record.regime).push(record.returnPct);
  }
  const byRegime = Object.fromEntries([...regimeRecords].map(([regime, values]) => [
    regime, summarizeReturns(values),
  ]));
  const sufficientlySampledRegimes = Object.values(byRegime)
    .filter((item) => item.trades >= policy.minimumTradesPerRegime);
  const profitableSampledRegimes = sufficientlySampledRegimes
    .filter((item) => item.expectancyPct > 0).length;
  const maximumPoolTrades = Math.max(0, ...poolCounts.values());
  const maximumPoolTradeConcentrationPct = analyzed.length
    ? round(maximumPoolTrades / analyzed.length * 100) : 0;
  const chronological = [...analyzed].sort((a, b) => a.closedAt - b.closedAt
    || a.episodeId.localeCompare(b.episodeId));
  const drawdown = maxPortfolioDrawdownPct(chronological, initialCash);

  const evidenceFailures = [];
  if (malformedRecords) evidenceFailures.push("malformed-records");
  if (duplicateEpisodes) evidenceFailures.push("duplicate-episodes");
  if (orphanedPartialCloses) evidenceFailures.push("orphaned-partial-closes");
  if (measurementFailures > policy.maximumMeasurementFailures) {
    evidenceFailures.push("measurement-failures");
  }
  if (riskBudgetBreaches) evidenceFailures.push("risk-budget-breaches");

  const sampleFailures = [];
  if (analyzed.length < policy.minimumClosedTrades) sampleFailures.push("insufficient-trades");
  if (poolCounts.size < policy.minimumUniquePools) sampleFailures.push("insufficient-unique-pools");
  if (sufficientlySampledRegimes.length < policy.minimumRegimes) {
    sampleFailures.push("insufficient-regime-coverage");
  }
  if (!outlierSampleSufficient) sampleFailures.push("insufficient-outlier-test-sample");

  const edgeFailures = [];
  if (summary.expectancyPct <= policy.minimumExpectancyPct) {
    edgeFailures.push("non-positive-expectancy");
  }
  if ((summary.profitFactor === null && summary.wins === 0)
      || (summary.profitFactor !== null
        && summary.profitFactor < policy.minimumProfitFactor)) {
    edgeFailures.push("profit-factor-below-threshold");
  }
  if (drawdown > policy.maximumPortfolioDrawdownPct) {
    edgeFailures.push("drawdown-above-threshold");
  }
  if (maximumPoolTradeConcentrationPct > policy.maximumPoolTradeConcentrationPct) {
    edgeFailures.push("pool-concentration-above-threshold");
  }
  if (stressed.expectancyPct <= 0) edgeFailures.push("stress-expectancy-non-positive");
  const outlierDependent = outlierSampleSufficient && summary.expectancyPct > 0
    && withoutBest.expectancyPct <= 0;
  if (outlierDependent) edgeFailures.push("outlier-dependent");
  const regimeDependent = sufficientlySampledRegimes.length >= policy.minimumRegimes
    && profitableSampledRegimes < policy.minimumRegimes;
  if (regimeDependent) edgeFailures.push("regime-dependent");

  let status = "paper-research-qualified";
  if (evidenceFailures.length) status = "invalid-evidence";
  else if (sampleFailures.length) status = "insufficient-sample";
  else if (outlierDependent) status = "outlier-dependent";
  else if (regimeDependent) status = "regime-dependent";
  else if (edgeFailures.length) status = "edge-not-demonstrated";

  const qualificationCaveats = [];
  if (summary.profitFactorReason === "undefined-no-losses") {
    qualificationCaveats.push("profit-factor-undefined-no-losses");
  }

  return {
    version: EPOCH_EVALUATOR_VERSION,
    policy: { ...policy },
    status,
    automaticPromotion: false,
    blockers: [...evidenceFailures, ...sampleFailures, ...edgeFailures],
    qualificationCaveats,
    integrity: {
      inputRecords: records.length,
      validRecords: valid.length,
      analyzedRecords: analyzed.length,
      malformedRecords,
      duplicateEpisodes,
      orphanedPartialCloses,
      measurementFailures,
      riskBudgetBreaches,
    },
    performance: {
      ...summary,
      derivedFromInvalidEvidence: evidenceFailures.length > 0,
      maximumPortfolioDrawdownPct: drawdown,
      uniquePools: poolCounts.size,
      maximumPoolTradeConcentrationPct,
    },
    stress: {
      additionalSlippagePctPerTrade: policy.additionalSlippagePctPerTrade,
      gasCostMultiplier: policy.gasCostMultiplier,
      ...stressed,
    },
    outlierTest: {
      removedBestTrades: orderedReturns.length - withoutBestValues.length,
      sufficientSample: outlierSampleSufficient,
      outlierDependent: outlierSampleSufficient ? outlierDependent : null,
      ...withoutBest,
    },
    regimes: {
      sufficientlySampled: sufficientlySampledRegimes.length,
      profitableSampled: profitableSampledRegimes,
      regimeDependent,
      byRegime,
    },
  };
}

export const EPOCH_EVALUATOR_BOUNDARY = Object.freeze({
  runtimeEnabled: false,
  automaticPromotion: false,
  paperMutationSupported: false,
  liveExecutionSupported: false,
});
