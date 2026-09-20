const finite = (value) => typeof value === "number" && Number.isFinite(value);

const summarizeReturns = (returns) => {
  const values = returns.filter(finite);
  const wins = values.filter((value) => value > 0);
  const losses = values.filter((value) => value < 0);
  const grossProfit = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  return {
    trades: values.length,
    winRatePct: values.length ? wins.length / values.length * 100 : 0,
    averageReturnPct: values.length
      ? values.reduce((sum, value) => sum + value, 0) / values.length : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? null : 0),
  };
};

export function simulateLifecycleCounterfactual(marks, {
  stopPct = null,
  takeProfitPct = null,
  trailingActivationPct = null,
  trailingDrawdownPct = null,
} = {}) {
  if (!Array.isArray(marks) || !marks.length
      || marks.some((mark) => !finite(mark?.returnPct))) {
    throw new Error("invalid-counterfactual-marks");
  }
  let peak = marks[0].returnPct;
  for (const mark of marks) {
    peak = Math.max(peak, mark.returnPct);
    // Conservative same-mark precedence: stop, then profit target, then trail.
    if (finite(stopPct) && stopPct > 0 && mark.returnPct <= -stopPct) {
      return { exitReturnPct: mark.returnPct, reason: `stop-${stopPct}`, markAt: mark.at ?? null };
    }
    if (finite(takeProfitPct) && takeProfitPct > 0 && mark.returnPct >= takeProfitPct) {
      return { exitReturnPct: mark.returnPct, reason: `take-profit-${takeProfitPct}`,
        markAt: mark.at ?? null };
    }
    if (finite(trailingActivationPct) && finite(trailingDrawdownPct)
        && peak >= trailingActivationPct && peak - mark.returnPct >= trailingDrawdownPct) {
      return { exitReturnPct: mark.returnPct, reason: "trailing-exit", markAt: mark.at ?? null };
    }
  }
  const last = marks.at(-1);
  return { exitReturnPct: last.returnPct, reason: "observation-end", markAt: last.at ?? null };
}

export function lifecycleCounterfactualMatrix(marks) {
  const policies = [
    ...[8, 15, 20, 30].map((stopPct) => ({ name: `stop-${stopPct}`, stopPct })),
    ...[5, 10, 20, 50].map((takeProfitPct) => ({
      name: `take-profit-${takeProfitPct}`, takeProfitPct,
    })),
    { name: "partial-era-trail-12", trailingActivationPct: 20, trailingDrawdownPct: 12 },
    { name: "wide-trail-20", trailingActivationPct: 20, trailingDrawdownPct: 20 },
  ];
  return Object.fromEntries(policies.map(({ name, ...policy }) => [
    name, simulateLifecycleCounterfactual(marks, policy),
  ]));
}

export function assessStrategyEvidence(records, {
  removeBestTrades = 3,
  minimumRemainingTrades = 5,
} = {}) {
  if (!Array.isArray(records) || records.some((record) => !finite(record?.returnPct))) {
    throw new Error("invalid-strategy-records");
  }
  if (!Number.isInteger(removeBestTrades) || removeBestTrades < 0
      || !Number.isInteger(minimumRemainingTrades) || minimumRemainingTrades < 1) {
    throw new Error("invalid-strategy-evidence-policy");
  }
  const ordered = records.map((record) => record.returnPct).sort((a, b) => b - a);
  const withoutBest = ordered.slice(Math.min(removeBestTrades, ordered.length));
  const all = summarizeReturns(ordered);
  const tailAdjusted = summarizeReturns(withoutBest);
  const sufficientSample = withoutBest.length >= minimumRemainingTrades;
  return {
    all,
    withoutBest: tailAdjusted,
    bestTradesRemoved: ordered.length - withoutBest.length,
    outlierDependence: sufficientSample
      ? (all.averageReturnPct > 0 && tailAdjusted.averageReturnPct <= 0)
      : "insufficient-sample",
  };
}

export function summarizeLifecycleAudit(trades) {
  if (!Array.isArray(trades)) throw new Error("invalid-lifecycle-trades");
  const closes = trades.filter((trade) => trade?.type === "close");
  const distribution = (field) => Object.fromEntries([...closes.reduce((map, trade) => {
    const value = trade[field] ?? "unrecorded";
    const key = String(value);
    map.set(key, Number(map.get(key) || 0) + 1);
    return map;
  }, new Map())]);
  const cadence = closes.map((trade) => Number(trade?.audit?.observedMarkIntervalMs))
    .filter(finite);
  return {
    entryBoundaryDistribution: distribution("entryAdverseBoundaryPct"),
    appliedBoundaryDistribution: distribution("appliedBoundaryPct"),
    trailExitCadenceMs: {
      samples: cadence.length,
      average: cadence.length
        ? cadence.reduce((sum, value) => sum + value, 0) / cadence.length : null,
    },
  };
}
