import { verifyGasMeasurement } from "./gas-measurement.js";

const HASH = /^0x[0-9a-f]{64}$/i;

// Reuse observations already obtained by the scanner; never backfill for gas.
export function observedGasTransactions(pools, quoteToken, now, maxAgeMs) {
  return [...pools].filter((pool) => pool.version === "v2"
    && [pool.token0, pool.token1].some((token) => (
      String(token).toLowerCase() === String(quoteToken).toLowerCase()
    ))
    && Number.isFinite(pool.lastSwapTimestampMs)
    && now >= pool.lastSwapTimestampMs
    && now - pool.lastSwapTimestampMs < maxAgeMs)
    .sort((a, b) => b.lastSwapTimestampMs - a.lastSwapTimestampMs)
    .map((pool) => pool.lastSwap?.transactionHash)
    .filter((hash) => HASH.test(String(hash)));
}

// At most three receipts and three blocks per renewal, with a shared in-flight
// promise. A configured fee floor remains mandatory; renewal never raises it.
export function createGasRefresher({ config, getReceipt, getBlock,
  retryMs = 5 * 60_000, verifyIntervalMs = 60 * 60_000 }) {
  let status = { verifiedInput: false, measuredAt: null, lastVerifiedAt: null,
    configuredWethPerSide: config.configuredWethPerSide,
    failures: [...config.failures] };
  let currentHash = config.transactionHash;
  let lastAttemptAt = null;
  let inFlight = null;
  let attempts = 0;
  let receiptsChecked = 0;
  let source = "configured";
  const validAt = (now) => status.verifiedInput === true
    && Number.isFinite(Date.parse(status.measuredAt))
    && now - Date.parse(status.measuredAt) <= config.maxAgeMs;

  function snapshot(now = Date.now()) {
    const stale = status.verifiedInput && !validAt(now);
    return { ...status, verifiedInput: stale ? false : status.verifiedInput,
      failures: stale ? ["gas-measurement-stale"] : [...status.failures],
      renewal: { source, lastAttemptAt, attempts, receiptsChecked,
        retryMs, verifyIntervalMs } };
  }

  function refresh({ transactionHashes = [], now = Date.now() } = {}) {
    if (inFlight) return inFlight;
    const healthy = validAt(now);
    const delay = healthy ? verifyIntervalMs : retryMs;
    if (lastAttemptAt !== null && now - lastAttemptAt < delay) {
      return Promise.resolve(snapshot(now));
    }
    lastAttemptAt = now;
    attempts += 1;
    const renewalDue = !healthy
      || now - Date.parse(status.measuredAt) >= config.maxAgeMs / 2;
    const hashes = [...new Set((renewalDue
      ? [...transactionHashes, currentHash] : [currentHash])
      .filter((hash) => HASH.test(String(hash))).map((hash) => hash.toLowerCase()))]
      .slice(0, 3);
    // Only a missing bootstrap transaction may be repaired by an observed swap.
    const failures = config.failures.filter((f) => f !== "gas-measurement-transaction-required");
    inFlight = (async () => {
      if (failures.length || !hashes.length) {
        status = { ...status, verifiedInput: false,
          failures: failures.length ? failures : ["gas-measurement-transaction-required"] };
        return snapshot(now);
      }
      for (const transactionHash of hashes) {
        receiptsChecked += 1;
        status = await verifyGasMeasurement({
          config: { ...config, transactionHash, configured: true, failures: [] },
          getReceipt, getBlock, now,
        });
        if (status.verifiedInput) {
          currentHash = transactionHash;
          source = transactionHash === config.transactionHash ? "configured" : "observed-swap";
          break;
        }
        // Do not hide a valid but more expensive sample behind a cheaper one.
        if (status.failures.includes("gas-weth-assumption-below-observed")) break;
      }
      return snapshot(now);
    })().finally(() => { inFlight = null; });
    return inFlight;
  }
  return { refresh, snapshot };
}
