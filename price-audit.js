const positiveFinite = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

export function auditSwapPrice({
  spotPriceQuote, swap, quoteIsToken0, token0Decimals, token1Decimals,
}) {
  const spot = positiveFinite(spotPriceQuote);
  if (!spot || !swap) return {
    lastSwapPriceQuote: null, spotVsLastSwapPct: null, priceAuditAvailable: false,
  };
  try {
    const amount0 = BigInt(swap.absoluteAmount0);
    const amount1 = BigInt(swap.absoluteAmount1);
    if (amount0 <= 0n || amount1 <= 0n) throw new Error("zero-swap-amount");
    const decimals0 = Number(token0Decimals);
    const decimals1 = Number(token1Decimals);
    if (![decimals0, decimals1].every(Number.isInteger)) throw new Error("invalid-decimals");
    const token0Human = Number(amount0) / (10 ** decimals0);
    const token1Human = Number(amount1) / (10 ** decimals1);
    const execution = quoteIsToken0
      ? token0Human / token1Human
      : token1Human / token0Human;
    if (!Number.isFinite(execution) || execution <= 0) throw new Error("invalid-execution-price");
    return {
      lastSwapPriceQuote: execution,
      spotVsLastSwapPct: Math.abs((spot / execution) - 1) * 100,
      priceAuditAvailable: true,
    };
  } catch {
    return {
      lastSwapPriceQuote: null, spotVsLastSwapPct: null, priceAuditAvailable: false,
    };
  }
}
