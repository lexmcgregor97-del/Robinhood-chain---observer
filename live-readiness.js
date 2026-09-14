export const DEFAULT_LIVE_PROMOTION_POLICY = Object.freeze({
  minPaperTrades: 50,
  minPaperExpectancy: 0,
  maxPaperDrawdownPct: 10,
  minShadowUniquePools: 20,
});

export function assessLiveReadiness(input, policy = DEFAULT_LIVE_PROMOTION_POLICY) {
  const paper = input?.paper || {};
  const shadow = input?.shadow || {};
  const failures = [];
  if (Number(paper.closedTrades || 0) < policy.minPaperTrades) failures.push("paper-sample-too-small");
  if (Number(paper.expectancyPerTrade || 0) <= policy.minPaperExpectancy) failures.push("paper-expectancy-not-positive");
  if (Number(paper.maxRealizedDrawdownPct || 0) > policy.maxPaperDrawdownPct) failures.push("paper-drawdown-too-high");
  if (Number(shadow.uniquePools || 0) < policy.minShadowUniquePools || shadow.eligible !== true) failures.push("shadow-evidence-insufficient");
  if (input?.sellProbeReady !== true) failures.push("sell-probe-not-ready");
  if (input?.walletConfigured !== true) failures.push("wallet-not-configured");
  if (Number(input?.rpcEndpointCount || 0) < 2) failures.push("rpc-redundancy-required");
  if (input?.operationalReady !== true) failures.push("runtime-not-ready");
  return {
    eligibleForMicroMainnet: failures.length === 0,
    failures,
    policy,
    progress: {
      paperTrades: Number(paper.closedTrades || 0),
      paperTradesRemaining: Math.max(0, policy.minPaperTrades - Number(paper.closedTrades || 0)),
      paperExpectancyPerTrade: Number(paper.expectancyPerTrade || 0),
      paperDrawdownPct: Number(paper.maxRealizedDrawdownPct || 0),
      shadowUniquePools: Number(shadow.uniquePools || 0),
    },
  };
}
