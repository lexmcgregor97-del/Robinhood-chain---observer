export const MAX_PAPER_DRAWDOWN_PCT = 10;

export const DEFAULT_PAPER_STRATEGY = Object.freeze({
  entryCashPct: 5,
  maxEntryNotional: 100,
  stopLossPct: 8,
  takeProfitPct: 35,
  trailingActivationPct: 10,
  trailingDrawdownPct: 6,
  maxHoldMs: 6 * 60 * 60 * 1000,
  maxRealizedDrawdownPct: MAX_PAPER_DRAWDOWN_PCT,
  reentryCooldownMs: 15 * 60 * 1000,
  maxEntriesPerPool: 3,
  liquidityCollapseImpactPct: 20,
});

const finite = (value) => Number.isFinite(Number(value));

export function paperCircuitFailures(analytics, policy = DEFAULT_PAPER_STRATEGY) {
  const failures = [];
  const limit = Number(policy?.maxRealizedDrawdownPct);
  if (!finite(limit) || limit <= 0 || limit > 100) {
    failures.push("invalid-drawdown-policy");
    return failures;
  }
  const drawdown = Math.max(
    Number(analytics?.maxRealizedDrawdownPct || 0),
    Number(analytics?.maxMarkedDrawdownPct
      ?? analytics?.markToMarketDrawdownPct ?? 0),
  );
  if (finite(drawdown) && drawdown >= limit) {
    failures.push("paper-drawdown-circuit-breaker");
  }
  return failures;
}

export function planPaperEntry(candidate, portfolio, policy = DEFAULT_PAPER_STRATEGY, now = Date.now()) {
  const failures = [];
  const midPrice = Number(candidate?.marketSafety?.tokenPriceQuote);
  const gasCost = Number(candidate?.marketSafety?.gasCostQuotePerSide || 0);
  const baseTokenDecimals = Number(candidate?.marketSafety?.baseTokenDecimals);
  const buyAmountOut = candidate?.marketSafety?.buyAmountOut;
  if (!candidate?.riskGate?.eligibleForPaperEntry) failures.push("risk-gate-rejected");
  if (!finite(midPrice) || midPrice <= 0) failures.push("price-unavailable");
  if (!Number.isInteger(baseTokenDecimals) || baseTokenDecimals < 0
      || baseTokenDecimals > 255 || buyAmountOut === undefined) {
    failures.push("executable-fill-unavailable");
  }
  if (!finite(portfolio?.cash) || portfolio.cash <= 0) failures.push("no-paper-cash");
  if (!finite(gasCost) || gasCost < 0) failures.push("invalid-gas-cost");
  if ((portfolio?.openPositions || []).some((p) => p.pool === candidate?.address)) failures.push("position-already-open");
  const maxEntriesPerPool = Number(policy.maxEntriesPerPool);
  if (!Number.isInteger(maxEntriesPerPool) || maxEntriesPerPool <= 0) {
    failures.push("invalid-pool-entry-limit");
  } else {
    const priorEntries = (portfolio?.trades || []).filter((trade) => (
      trade?.type === "open" && trade.pool === candidate?.address
    )).length;
    if (priorEntries >= maxEntriesPerPool) failures.push("pool-epoch-entry-limit");
  }
  const cooldownMs = Number(policy.reentryCooldownMs);
  if (finite(cooldownMs) && cooldownMs > 0) {
    const lastClose = (portfolio?.trades || []).reduce((latest, trade) => (
      trade?.type === "close" && trade.pool === candidate?.address
        && Number(trade.timestamp) > latest ? Number(trade.timestamp) : latest
    ), 0);
    if (lastClose && now - lastClose < cooldownMs) failures.push("pool-reentry-cooldown");
  }
  if (Number.isInteger(Number(portfolio?.maxPositions))
      && (portfolio?.openPositions || []).length >= Number(portfolio.maxPositions)) {
    failures.push("position-limit-reached");
  }
  const entryPct = Number(policy.entryCashPct);
  const cap = Number(policy.maxEntryNotional);
  if (!finite(entryPct) || entryPct <= 0 || entryPct > 100 || !finite(cap) || cap <= 0) {
    failures.push("invalid-entry-policy");
  }
  const notional = failures.length ? 0 : Math.min(portfolio.cash * entryPct / 100, cap);
  if (!failures.length && notional + gasCost > portfolio.cash) failures.push("insufficient-paper-cash");
  const measuredNotional = Number(candidate?.marketSafety?.plannedNotionalQuote);
  if (!failures.length && (!finite(measuredNotional)
      || Math.abs(measuredNotional - notional) > Math.max(1e-12, notional * 1e-9))) {
    failures.push("fill-size-mismatch");
  }
  let quantity = 0;
  if (!failures.length) {
    try {
      quantity = Number(BigInt(buyAmountOut)) / (10 ** baseTokenDecimals);
      if (!finite(quantity) || quantity <= 0) failures.push("executable-fill-unavailable");
    } catch {
      failures.push("executable-fill-unavailable");
    }
  }
  const executionPrice = quantity > 0 ? notional / quantity : 0;
  return {
    approved: failures.length === 0 && notional > 0,
    failures,
    order: failures.length ? null : {
      pool: candidate.address,
      token: candidate.marketSafety.baseToken,
      price: executionPrice,
      midPrice,
      quantity,
      quantityUnits: String(BigInt(buyAmountOut)),
      notional,
      gasCost,
    },
  };
}

export function paperExitReason(position, now = Date.now(), policy = DEFAULT_PAPER_STRATEGY) {
  const returnPct = Number(position?.returnPct);
  const peakReturnPct = Number(position?.peakReturnPct ?? returnPct);
  const exitPriceImpactPct = Number(position?.exitPriceImpactPct);
  const heldMs = Number(now) - Number(position?.openedAt);
  if (![returnPct, peakReturnPct, heldMs].every(Number.isFinite)) return null;
  if (Number.isFinite(exitPriceImpactPct)
      && exitPriceImpactPct >= Number(policy.liquidityCollapseImpactPct)) {
    return "liquidity-collapse";
  }
  if (returnPct <= -Number(policy.stopLossPct)) return "stop-loss";
  if (returnPct >= Number(policy.takeProfitPct)) return "take-profit";
  if (peakReturnPct >= Number(policy.trailingActivationPct)
      && peakReturnPct - returnPct >= Number(policy.trailingDrawdownPct)) return "trailing-stop";
  if (heldMs >= Number(policy.maxHoldMs)) return "max-hold";
  return null;
}
