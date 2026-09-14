export const DEFAULT_PAPER_POLICY = Object.freeze({
  minPoolAgeMs: 5 * 60_000,
  maxPriceImpactPct: 5,
  maxExecutionCostPct: 15,
  maxSpotSwapDeviationPct: 5,
  requiredSignal: "escape-velocity",
});

export function evaluateRiskGate(candidate, policy = DEFAULT_PAPER_POLICY) {
  const failures = [];
  const safety = candidate.marketSafety || {};
  const signal = candidate.signal || {};
  const allowedSignals = policy.allowedSignals || [policy.requiredSignal];
  if (!allowedSignals.includes(signal.state)) failures.push("signal-not-ready");
  if (Number.isFinite(Number(policy.minSwaps))
      && Number(signal.swapsCurrentWindow) < Number(policy.minSwaps)) {
    failures.push("signal-activity-too-low");
  }
  if (Number.isFinite(Number(policy.minAcceleration))
      && Number(signal.acceleration) < Number(policy.minAcceleration)) {
    failures.push("signal-acceleration-too-low");
  }
  if (Number.isFinite(Number(policy.maxAcceleration))
      && Number(signal.acceleration) > Number(policy.maxAcceleration)) {
    failures.push("signal-acceleration-too-high");
  }
  if (!safety.quoteTokenKnown) failures.push("unknown-quote-token");
  if (!safety.liquidityKnown) failures.push("liquidity-not-measured");
  if (!safety.buyMathOk) failures.push("buy-math-failed");
  if (!safety.sellMathOk) failures.push("sell-math-failed");
  if (policy.requireGasEstimate && safety.gasEstimateAvailable !== true) {
    failures.push("gas-estimate-required");
  }
  if (policy.requireSellProbe && safety.sellProbe?.passed !== true) {
    failures.push("sell-probe-required");
  }
  if (candidate.version === "v3" && !safety.tickBoundaryKnown) failures.push("v3-tick-boundary-unmeasured");
  if (candidate.version === "v3" && safety.tickBoundaryKnown && !safety.staysWithinActiveTick) failures.push("v3-probe-crosses-tick");
  if (!safety.priceAuditAvailable) failures.push("price-audit-unavailable");
  else if (!Number.isFinite(safety.spotVsLastSwapPct)
      || safety.spotVsLastSwapPct > policy.maxSpotSwapDeviationPct) {
    failures.push("spot-swap-price-dislocation");
  }
  if (!Number.isFinite(safety.poolAgeMs) || safety.poolAgeMs < policy.minPoolAgeMs) {
    failures.push("pool-too-new");
  }
  if (!Number.isFinite(safety.priceImpactPct)
      || safety.priceImpactPct > policy.maxPriceImpactPct) failures.push("price-impact-too-high");
  if (!Number.isFinite(safety.executionCostPct)
      || safety.executionCostPct > policy.maxExecutionCostPct) {
    failures.push("execution-cost-too-high");
  }
  return { eligibleForPaperEntry: failures.length === 0, failures, policy };
}
