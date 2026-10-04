import { rankPools } from "./signals.js";

export function isPaperMarket(pool, quoteTokens) {
  return pool.version === "v2"
    && quoteTokens.has(pool.token0) !== quoteTokens.has(pool.token1);
}

// Select within the supported universe before applying the measurement budget.
export function rankPaperPools(pools, nowMs, { quoteTokens, limit = 25, ...options }) {
  return rankPools(pools.filter((pool) => isPaperMarket(pool, quoteTokens)), nowMs, options)
    .slice(0, limit);
}

// Keep the registry bounded without freezing it at the first 5,000 discoveries.
// Only dormant pools may be replaced. The caller pins open positions, pending
// research samples, and every pool trading in the range currently being scanned.
export function poolAdmission(pools, incoming, {
  capacity, nowMs, retentionMs, protectedAddresses = new Set(),
}) {
  if (pools.has(incoming.address)) return { admitted: false, reason: "already-known" };
  if (pools.size < capacity) return { admitted: true, evict: null };
  if (!Number.isFinite(nowMs) || nowMs <= 0
      || !Number.isFinite(retentionMs) || retentionMs <= 0) {
    return { admitted: false, reason: "capacity-protected" };
  }
  let oldest = null;
  let oldestAt = Infinity;
  for (const pool of pools.values()) {
    if (protectedAddresses.has(pool.address)) continue;
    const lastSeen = Math.max(Number(pool.lastSwapTimestampMs) || 0,
      Number(pool.discoveryTimestampMs) || 0);
    if (lastSeen > nowMs - retentionMs) continue;
    if (lastSeen < oldestAt) { oldest = pool.address; oldestAt = lastSeen; }
  }
  return oldest === null
    ? { admitted: false, reason: "capacity-protected" }
    : { admitted: true, evict: oldest };
}
