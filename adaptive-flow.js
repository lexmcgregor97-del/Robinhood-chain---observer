const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_BASELINE_MS = 60 * 60_000;
const DEFAULT_TRIM_FRACTION = 0.2;

const lower = (value) => String(value || "").toLowerCase();
const finitePositive = (value) => Number.isFinite(value) && value > 0;
const flowQuoteAmount = (flow) => Number(flow?.quoteAmount)
  || (Number(flow?.buyQuoteVolume) || 0) + (Number(flow?.sellQuoteVolume) || 0);
const flowBuyAmount = (flow) => flow?.side === "buy"
  ? Number(flow?.quoteAmount) || 0 : Number(flow?.buyQuoteVolume) || 0;

export function quoteFlowFromSwap(pool, swap, quoteTokens = []) {
  const quotes = new Map(quoteTokens.map((token) => [lower(token.address), token]));
  const token0Quote = quotes.get(lower(pool?.token0));
  const token1Quote = quotes.get(lower(pool?.token1));
  if (Boolean(token0Quote) === Boolean(token1Quote)) return null;
  const quote = token0Quote || token1Quote;
  const rawAmount = BigInt(token0Quote ? swap.amount0 : swap.amount1);
  const decimals = Number(quote.decimals);
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) return null;
  const quoteAmount = Number(rawAmount < 0n ? -rawAmount : rawAmount) / (10 ** decimals);
  if (!finitePositive(quoteAmount)) return null;
  return {
    quoteAmount,
    side: rawAmount > 0n ? "buy" : "sell",
    quoteToken: quote.address,
    quoteSymbol: quote.symbol,
  };
}

function minuteVolumes(flows, fromMs, toMs, minuteMs) {
  const count = Math.ceil((toMs - fromMs) / minuteMs);
  const volumes = Array.from({ length: count }, () => 0);
  for (const flow of flows) {
    const timestampMs = Number(flow?.timestampMs);
    const quoteAmount = flowQuoteAmount(flow);
    if (timestampMs < fromMs || timestampMs >= toMs || !finitePositive(quoteAmount)) continue;
    volumes[Math.floor((timestampMs - fromMs) / minuteMs)] += quoteAmount;
  }
  return volumes;
}

export function adaptiveFlowSignal(flows = [], nowMs = Date.now(), options = {}) {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const baselineMs = options.baselineMs ?? DEFAULT_BASELINE_MS;
  const trimFraction = options.trimFraction ?? DEFAULT_TRIM_FRACTION;
  const minActiveBaselineMinutes = options.minActiveBaselineMinutes ?? 10;
  const currentFloor = Math.floor(nowMs / windowMs) * windowMs;
  const baselineFloor = currentFloor - baselineMs;
  const currentFlows = flows.filter((flow) => {
    const timestampMs = Number(flow?.timestampMs);
    return timestampMs >= currentFloor && timestampMs <= nowMs
      && finitePositive(flowQuoteAmount(flow));
  });
  const currentQuoteVolume = currentFlows.reduce(
    (sum, flow) => sum + flowQuoteAmount(flow), 0,
  );
  const buyQuoteVolume = currentFlows
    .reduce((sum, flow) => sum + flowBuyAmount(flow), 0);
  const volumes = minuteVolumes(flows, baselineFloor, currentFloor, windowMs);
  const active = volumes.filter(finitePositive).sort((a, b) => a - b);
  const trimCount = Math.floor(active.length * trimFraction);
  const kept = active.slice(0, Math.max(1, active.length - trimCount));
  const baselineDivisor = Math.max(kept.length, minActiveBaselineMinutes);
  const baselineQuoteVolumePerMinute = kept.length
    ? kept.reduce((sum, value) => sum + value, 0) / baselineDivisor : 0;
  const ready = active.length >= minActiveBaselineMinutes
    && finitePositive(baselineQuoteVolumePerMinute);
  return {
    ready,
    currentQuoteVolume,
    baselineQuoteVolumePerMinute,
    volumeMultiple: ready ? currentQuoteVolume / baselineQuoteVolumePerMinute : null,
    buyShare: currentQuoteVolume > 0 ? buyQuoteVolume / currentQuoteVolume : 0,
    buys: currentFlows.reduce((sum, flow) => sum
      + (Number(flow?.buys) || (flow.side === "buy" ? 1 : 0)), 0),
    sells: currentFlows.reduce((sum, flow) => sum
      + (Number(flow?.sells) || (flow.side === "sell" ? 1 : 0)), 0),
    activeBaselineMinutes: active.length,
    baselineMinutes: volumes.length,
    baselineMethod: "trimmed-active-minute-mean",
    trimFraction,
  };
}
