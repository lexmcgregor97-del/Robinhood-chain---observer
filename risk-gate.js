export const DEFAULT_PAPER_POLICY = Object.freeze({
  minPoolAgeBlocks: 20,
  maxPriceImpactPct: 5,
  maxRoundTripLossPct: 15,
  maxSpotSwapDeviationPct: 5,
  requiredSignal: "escape-velocity",
});

export function evaluateRiskGate(candidate, policy = DEFAULT_PAPER_POLICY) {
  const failures = [];
  const safety = candidate.marketSafety || {};
  if (candidate.signal?.state !== policy.requiredSignal) failures.push("signal-not-ready");
  if (!safety.quoteTokenKnown) failures.push("unknown-quote-token");
  if (!safety.liquidityKnown) failures.push("liquidity-not-measured");
  if (!safety.buySimulationOk) failures.push("buy-simulation-failed");
  if (!safety.sellSimulationOk) failures.push("sell-simulation-failed");
  if (candidate.version === "v3" && !safety.tickBoundaryKnown) failures.push("v3-tick-boundary-unmeasured");
  if (candidate.version === "v3" && safety.tickBoundaryKnown && !safety.staysWithinActiveTick) failures.push("v3-probe-crosses-tick");
  if (!safety.priceAuditAvailable) failures.push("price-audit-unavailable");
  else if (!Number.isFinite(safety.spotVsLastSwapPct)
      || safety.spotVsLastSwapPct > policy.maxSpotSwapDeviationPct) {
    failures.push("spot-swap-price-dislocation");
  }
  if (!Number.isFinite(safety.poolAgeBlocks) || safety.poolAgeBlocks < policy.minPoolAgeBlocks) failures.push("pool-too-new");
  if (!Number.isFinite(safety.priceImpactPct) || safety.priceImpactPct > policy.maxPriceImpactPct) failures.push("price-impact-too-high");
  if (!Number.isFinite(safety.roundTripLossPct) || safety.roundTripLossPct > policy.maxRoundTripLossPct) failures.push("round-trip-loss-too-high");
  return { eligibleForPaperEntry: failures.length === 0, failures, policy };
}
