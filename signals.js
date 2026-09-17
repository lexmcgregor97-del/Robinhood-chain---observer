import { adaptiveFlowSignal } from "./adaptive-flow.js";

function totalSwaps(blocks, fromMs, toMs) {
  return blocks.reduce((total, bucket) => {
    const timestampMs = Number(bucket.timestampMs);
    return timestampMs >= fromMs && timestampMs < toMs
      ? total + (Number(bucket.count) || 0)
      : total;
  }, 0);
}

export function scorePool(pool, nowMs, options = {}) {
  const windowMs = options.windowMs ?? 60_000;
  const baselineMs = options.baselineMs ?? 300_000;
  const minSwaps = options.minSwaps ?? 3;
  const blocks = pool.recentBlocks || [];
  const currentFloor = nowMs - windowMs;
  const baselineFloor = currentFloor - baselineMs;
  const current = totalSwaps(blocks, currentFloor, nowMs + 1);
  const baseline = totalSwaps(blocks, baselineFloor, currentFloor);
  const baselineEquivalent = baseline * (windowMs / baselineMs);
  const acceleration = baselineEquivalent === 0 ? current : current / baselineEquivalent;
  const lastSwapTimestampMs = Number(pool.lastSwapTimestampMs) || 0;
  const recency = lastSwapTimestampMs
    ? Math.max(0, windowMs - (nowMs - lastSwapTimestampMs)) / windowMs
    : 0;
  const score = Math.round((
    current * 10 + Math.min(acceleration, 10) * 12 + recency * 8
  ) * 10) / 10;
  let state = "quiet";
  if (current >= minSwaps) state = acceleration >= 2 ? "breakout-watch" : "active";
  if (current >= minSwaps * 2 && acceleration >= 3) state = "escape-velocity";
  return {
    score,
    state,
    swapsCurrentWindow: current,
    swapsBaselineWindow: baseline,
    baselineEquivalent: Math.round(baselineEquivalent * 100) / 100,
    acceleration: Math.round(acceleration * 100) / 100,
    windowMs,
    baselineMs,
    adaptiveFlow: adaptiveFlowSignal(pool.recentFlows, nowMs, options.flow),
  };
}

export function rankPools(poolList, nowMs, options = {}) {
  return poolList
    .map((pool) => ({ ...pool, signal: scorePool(pool, nowMs, options) }))
    .filter((pool) => pool.signal.swapsCurrentWindow > 0)
    .sort((a, b) => b.signal.score - a.signal.score);
}
