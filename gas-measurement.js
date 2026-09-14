const TX_HASH = /^0x[0-9a-f]{64}$/i;

export function gasMeasurementFromEnv(env = process.env, now = Date.now()) {
  const transactionHash = String(env.PAPER_GAS_MEASUREMENT_TX || "").toLowerCase();
  const measuredAt = Date.parse(String(env.PAPER_GAS_MEASURED_AT || ""));
  const maxAgeMs = Number(env.PAPER_GAS_MAX_AGE_MS || 7 * 24 * 60 * 60_000);
  const ageMs = now - measuredAt;
  const failures = [];
  if (!TX_HASH.test(transactionHash)) failures.push("gas-measurement-transaction-required");
  if (!Number.isFinite(measuredAt)) failures.push("gas-measurement-time-required");
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) failures.push("invalid-gas-measurement-max-age");
  if (Number.isFinite(ageMs) && (ageMs < -5 * 60_000 || ageMs > maxAgeMs)) {
    failures.push("gas-measurement-stale");
  }
  return {
    verifiedInput: failures.length === 0,
    transactionHash: TX_HASH.test(transactionHash) ? transactionHash : null,
    measuredAt: Number.isFinite(measuredAt) ? new Date(measuredAt).toISOString() : null,
    ageMs: Number.isFinite(ageMs) ? ageMs : null,
    maxAgeMs,
    failures,
  };
}
