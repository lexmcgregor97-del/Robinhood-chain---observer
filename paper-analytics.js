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

export function analyzePaperTrades({ initialCash, trades = [], strategyVersion = null }) {
  initialCash = finite(initialCash);
  const openByPool = new Map();
  const closed = [];
  let feesPaid = 0;
  let equity = initialCash;
  let peakEquity = initialCash;
  let maxDrawdownPct = 0;

  for (const trade of trades) {
    if (!strategyVersion) feesPaid += Math.max(0, finite(trade.fee));
    if (trade.type === "open") {
      if (strategyVersion && trade.audit?.strategyVersion !== strategyVersion) continue;
      if (strategyVersion) feesPaid += Math.max(0, finite(trade.fee));
      openByPool.set(trade.pool, trade);
      continue;
    }
    if (trade.type !== "close") continue;
    const entry = openByPool.get(trade.pool);
    if (!entry) continue;
    if (strategyVersion) feesPaid += Math.max(0, finite(trade.fee));
    openByPool.delete(trade.pool);
    const pnl = finite(trade.pnl);
    const notional = finite(entry.notional);
    const record = {
      pool: trade.pool,
      token: trade.token || entry.token,
      pnl,
      returnPct: notional > 0 ? (pnl / notional) * 100 : 0,
      holdMs: Math.max(0, finite(trade.timestamp) - finite(entry.timestamp)),
      reason: trade.reason || "unknown",
      signal: entry.audit?.signal || "unknown",
      version: entry.audit?.version || "unknown",
      venue: entry.audit?.venue || "unknown",
      strategyVersion: entry.audit?.strategyVersion || "legacy",
    };
    closed.push(record);
    equity += pnl;
    peakEquity = Math.max(peakEquity, equity);
    if (peakEquity > 0) {
      maxDrawdownPct = Math.max(maxDrawdownPct, ((peakEquity - equity) / peakEquity) * 100);
    }
  }

  const wins = closed.filter((record) => record.pnl > 0);
  const losses = closed.filter((record) => record.pnl < 0);
  const total = summarize(closed);
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
    feesPaid,
    openTrades: openByPool.size,
    bySignal: grouped(closed, "signal"),
    byVersion: grouped(closed, "version"),
    byVenue: grouped(closed, "venue"),
    byExitReason: grouped(closed, "reason"),
  };
}
