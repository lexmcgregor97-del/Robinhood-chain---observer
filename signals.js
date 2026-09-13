export function scorePool(pool, latestBlock, options = {}) {
  const windowBlocks = options.windowBlocks ?? 20;
  const minSwaps = options.minSwaps ?? 3;
  const events = pool.recent || [];
  const currentFloor = latestBlock - windowBlocks + 1;
  const priorFloor = latestBlock - (windowBlocks * 2) + 1;
  const current = events.filter((block) => block >= currentFloor).length;
  const prior = events.filter((block) => block >= priorFloor && block < currentFloor).length;
  const acceleration = prior === 0 ? current : current / prior;
  const recency = pool.lastSwapBlock ? Math.max(0, windowBlocks - (latestBlock - pool.lastSwapBlock)) / windowBlocks : 0;
  const score = Math.round((current * 10 + Math.min(acceleration, 10) * 12 + recency * 8) * 10) / 10;
  let state = "quiet";
  if (current >= minSwaps) state = acceleration >= 2 ? "breakout-watch" : "active";
  if (current >= minSwaps * 2 && acceleration >= 3) state = "escape-velocity";
  return { score, state, swapsCurrentWindow: current, swapsPriorWindow: prior,
    acceleration: Math.round(acceleration * 100) / 100, windowBlocks };
}

export function rankPools(poolList, latestBlock, options = {}) {
  return poolList.map((pool) => ({ ...pool, signal: scorePool(pool, latestBlock, options) }))
    .filter((pool) => pool.signal.swapsCurrentWindow > 0)
    .sort((a, b) => b.signal.score - a.signal.score);
}
