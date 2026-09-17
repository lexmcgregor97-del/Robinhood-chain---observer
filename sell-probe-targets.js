export function selectSellProbeTargets(candidates, {
  observedSellFor,
  hasFreshProbe,
  isPaperEntryEligible,
  limit = 3,
} = {}) {
  if (!Array.isArray(candidates) || !Number.isInteger(limit) || limit <= 0) return [];
  if (![observedSellFor, hasFreshProbe, isPaperEntryEligible]
    .every((callback) => typeof callback === "function")) return [];

  const targets = [];
  const selectedPools = new Set();
  for (const candidate of candidates) {
    if (candidate?.version !== "v2"
        || candidate?.marketSafety?.buyMathOk !== true
        || candidate?.marketSafety?.sellMathOk !== true
        || hasFreshProbe(candidate)
        || !isPaperEntryEligible(candidate)) continue;
    const pool = String(candidate.address || "").toLowerCase();
    if (!pool || selectedPools.has(pool)) continue;
    const observedSell = observedSellFor(candidate);
    if (!observedSell?.transactionHash) continue;
    selectedPools.add(pool);
    targets.push({ candidate, observedSell });
    if (targets.length >= limit) break;
  }
  return targets;
}
