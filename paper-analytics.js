const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

function summarize(records) {
  const trades = records.length;
  const wins = records.filter((record) => record.pnl > 0).length;
  const pnl = records.reduce((sum, record) => sum + record.pnl, 0);
  const returns = records.reduce((sum, record) => sum + record.returnPct, 0);
  return {
    trades,
    wins,
    losses: records.filter((record) => record.pnl < 0).length,
    winRatePct: trades ? (wins / trades) * 100 : 0,
    pnl,
    averageReturnPct: trades ? returns / trades : 0,
  };
}

function grouped(records, field) {
  const buckets = new Map();
  for (const record of records) {
    const key = String(record[field] || "unknown");
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(record);
  }
  return Object.fromEntries([...buckets].map(([key, values]) => [key, summarize(values)]));
}

export function analyzePaperTrades({
  initialCash, trades = [], strategyVersion = null, openPositions = [],
  priorMaxMarkedDrawdownPct = 0,
}) {
  initialCash = finite(initialCash);
  const openByPool = new Map();
  const closed = [];
  const partials = [];
  let feesPaid = 0;
  let equity = initialCash;
  let peakEquity = initialCash;
  let maxDrawdownPct = 0;

  for (const trade of trades) {
    if (!strategyVersion) feesPaid += Math.max(0, finite(trade.fee));
    if (trade.type === "open") {
      if (strategyVersion && trade.audit?.strategyVersion !== strategyVersion) continue;
      if (strategyVersion) feesPaid += Math.max(0, finite(trade.fee));
      openByPool.set(trade.pool, { entry: trade, partialPnl: 0, partialGas: 0,
        partialCount: 0, partialReasons: [] });
      continue;
    }
    if (trade.type === "partial-close") {
      const lifecycle = openByPool.get(trade.pool);
      if (!lifecycle) continue;
      if (strategyVersion) feesPaid += Math.max(0, finite(trade.fee));
      const pnl = finite(trade.pnl);
      lifecycle.partialPnl += pnl;
      lifecycle.partialGas += Math.max(0, finite(trade.gasCost));
      lifecycle.partialCount += 1;
      lifecycle.partialReasons.push(trade.reason || "unknown");
      partials.push({ pool: trade.pool, pnl, reason: trade.reason || "unknown",
        returnPct: finite(trade.allocatedCostBasis) > 0
          ? (pnl / finite(trade.allocatedCostBasis)) * 100 : 0 });
      equity += pnl;
      peakEquity = Math.max(peakEquity, equity);
      if (peakEquity > 0) {
        maxDrawdownPct = Math.max(maxDrawdownPct, ((peakEquity - equity) / peakEquity) * 100);
      }
      continue;
    }
    if (trade.type !== "close") continue;
    const lifecycle = openByPool.get(trade.pool);
    if (!lifecycle) continue;
    const { entry } = lifecycle;
    if (strategyVersion) feesPaid += Math.max(0, finite(trade.fee));
    openByPool.delete(trade.pool);
    const remainderPnl = finite(trade.pnl);
    const pnl = lifecycle.partialPnl + remainderPnl;
    const costBasis = finite(entry.notional) + Math.max(0, finite(entry.gasCost));
    const record = {
      pool: trade.pool,
      token: trade.token || entry.token,
      pnl,
      returnPct: costBasis > 0 ? (pnl / costBasis) * 100 : 0,
      holdMs: Math.max(0, finite(trade.timestamp) - finite(entry.timestamp)),
      reason: trade.reason || "unknown",
      signal: entry.audit?.signal || "unknown",
      version: entry.audit?.version || "unknown",
      venue: entry.audit?.venue || "unknown",
      strategyVersion: entry.audit?.strategyVersion || "legacy",
      gasCost: finite(entry.gasCost) + lifecycle.partialGas + finite(trade.gasCost),
      partialCloseCount: lifecycle.partialCount,
      partialRealizedPnl: lifecycle.partialPnl,
      remainderPnl,
      partialReasons: [...lifecycle.partialReasons],
      maxFavorableExcursionPct: Number.isFinite(Number(trade.maxFavorableExcursionPct))
        ? Number(trade.maxFavorableExcursionPct) : null,
      maxAdverseExcursionPct: Number.isFinite(Number(trade.maxAdverseExcursionPct))
        ? Number(trade.maxAdverseExcursionPct) : null,
      measurementFailure: trade.measurementFailure === true
        || trade.reason === "price-unavailable-timeout",
    };
    closed.push(record);
    equity += remainderPnl;
    peakEquity = Math.max(peakEquity, equity);
    if (peakEquity > 0) {
      maxDrawdownPct = Math.max(maxDrawdownPct, ((peakEquity - equity) / peakEquity) * 100);
    }
  }

  const wins = closed.filter((record) => record.pnl > 0);
  const losses = closed.filter((record) => record.pnl < 0);
  const total = summarize(closed);
  const unrealizedPnl = (openPositions || []).reduce(
    (sum, position) => sum + finite(position?.unrealizedPnl), 0,
  );
  const currentMarkedEquity = equity + unrealizedPnl;
  const currentMarkedDrawdownPct = peakEquity > 0
    ? Math.max(maxDrawdownPct, ((peakEquity - currentMarkedEquity) / peakEquity) * 100)
    : maxDrawdownPct;
  const maxMarkedDrawdownPct = Math.max(
    Math.max(0, finite(priorMaxMarkedDrawdownPct)), currentMarkedDrawdownPct,
  );
  return {
    closedTrades: total.trades,
    wins: total.wins,
    losses: total.losses,
    winRatePct: total.winRatePct,
    realizedPnl: total.pnl,
    expectancyPerTrade: total.trades ? total.pnl / total.trades : 0,
    averageWin: wins.length ? wins.reduce((sum, record) => sum + record.pnl, 0) / wins.length : 0,
    averageLoss: losses.length ? losses.reduce((sum, record) => sum + record.pnl, 0) / losses.length : 0,
    averageHoldMs: closed.length
      ? closed.reduce((sum, record) => sum + record.holdMs, 0) / closed.length : 0,
    maxRealizedDrawdownPct: maxDrawdownPct,
    currentMarkedDrawdownPct,
    maxMarkedDrawdownPct,
    markToMarketDrawdownPct: maxMarkedDrawdownPct,
    currentMarkedEquity,
    unrealizedPnl,
    // Closes booked at zero because the exit could not be measured (RPC or
    // conversion failure), not because the market went to zero. They stay in
    // the P&L (conservative) but any non-zero count invalidates the cohort.
    measurementFailures: closed.filter((record) => record.measurementFailure).length,
    uniquePools: new Set(closed.map((record) => record.pool)).size,
    feesPaid,
    estimatedLpFees: feesPaid,
    gasPaid: closed.reduce((sum, record) => sum + record.gasCost, 0),
    partialCloses: partials.length,
    positionsWithPartial: closed.filter((record) => record.partialCloseCount > 0).length,
    partialRealizedPnl: partials.reduce((sum, record) => sum + record.pnl, 0),
    remainderPnlAfterPartial: closed.filter((record) => record.partialCloseCount > 0)
      .reduce((sum, record) => sum + record.remainderPnl, 0),
    averageMaxFavorableExcursionPct: (() => {
      const measured = closed.filter((record) => record.maxFavorableExcursionPct !== null);
      return measured.length ? measured.reduce(
        (sum, record) => sum + record.maxFavorableExcursionPct, 0,
      ) / measured.length : 0;
    })(),
    averageMaxAdverseExcursionPct: (() => {
      const measured = closed.filter((record) => record.maxAdverseExcursionPct !== null);
      return measured.length ? measured.reduce(
        (sum, record) => sum + record.maxAdverseExcursionPct, 0,
      ) / measured.length : 0;
    })(),
    openTrades: openByPool.size,
    bySignal: grouped(closed, "signal"),
    byVersion: grouped(closed, "version"),
    byVenue: grouped(closed, "venue"),
    byExitReason: grouped(closed, "reason"),
    byPartialExitReason: grouped(partials, "reason"),
  };
}
