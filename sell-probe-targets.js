export function selectSellProbeTargets(candidates, {
  observedSellFor,
  hasFreshProbe,
  isPaperEntryEligible,
  limit = 3,
  diagnostics = {},
} = {}) {
  Object.assign(diagnostics, { considered: 0, wrongVersion: 0, invalidMath: 0,
    freshProbe: 0, entryBlocked: 0, missingObservedSell: 0,
    duplicatePool: 0, selected: 0 });
  if (!Array.isArray(candidates) || !Number.isInteger(limit) || limit <= 0) return [];
  if (![observedSellFor, hasFreshProbe, isPaperEntryEligible]
    .every((callback) => typeof callback === "function")) return [];

  const targets = [];
  const selectedPools = new Set();
  for (const candidate of candidates) {
    diagnostics.considered += 1;
    if (candidate?.version !== "v2") { diagnostics.wrongVersion += 1; continue; }
    if (candidate?.marketSafety?.buyMathOk !== true
        || candidate?.marketSafety?.sellMathOk !== true) {
      diagnostics.invalidMath += 1; continue;
    }
    if (hasFreshProbe(candidate)) { diagnostics.freshProbe += 1; continue; }
    if (!isPaperEntryEligible(candidate)) { diagnostics.entryBlocked += 1; continue; }
    const pool = String(candidate.address || "").toLowerCase();
    if (!pool || selectedPools.has(pool)) { diagnostics.duplicatePool += 1; continue; }
    const observedSell = observedSellFor(candidate);
    if (!observedSell?.transactionHash) { diagnostics.missingObservedSell += 1; continue; }
    selectedPools.add(pool);
    targets.push({ candidate, observedSell });
    diagnostics.selected += 1;
    if (targets.length >= limit) break;
  }
  return targets;
}

export function sellProbeAttemptDisposition({
  targetCount,
  now,
  lastAttemptAt,
  intervalMs,
} = {}) {
  if (!Number.isInteger(targetCount) || targetCount < 0
      || !Number.isFinite(Number(now))
      || !Number.isFinite(Number(lastAttemptAt))
      || !Number.isFinite(Number(intervalMs)) || Number(intervalMs) <= 0) {
    return Object.freeze({ start: false, reason: "invalid-probe-attempt-state" });
  }
  if (targetCount === 0) {
    return Object.freeze({ start: false, reason: "sell-probe-candidate-unavailable" });
  }
  if (Number(now) - Number(lastAttemptAt) < Number(intervalMs)) {
    return Object.freeze({ start: false, reason: "sell-probe-cooldown" });
  }
  return Object.freeze({ start: true, reason: null });
}
