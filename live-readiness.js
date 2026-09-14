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
  const paperDrawdownPct = Math.max(Number(paper.maxRealizedDrawdownPct || 0),
    Number(paper.maxMarkedDrawdownPct ?? paper.markToMarketDrawdownPct ?? 0));
  if (paperDrawdownPct > policy.maxPaperDrawdownPct) failures.push("paper-drawdown-too-high");
  if (Number(paper.measurementFailures || 0) > 0) failures.push("paper-measurement-failures-present");
  if (Number(shadow.uniquePools || 0) < policy.minShadowUniquePools || shadow.eligible !== true) failures.push("shadow-evidence-insufficient");
  if (input?.sellProbeReady !== true) failures.push("sell-probe-not-ready");
  if (input?.walletConfigured !== true) failures.push("wallet-not-configured");
  if (input?.turnkeyPolicyAttested !== true) failures.push("turnkey-policy-not-attested");
  if (input?.turnkeyPolicyVerified !== true) failures.push("turnkey-policy-not-verified");
  if (Number(input?.rpcEndpointCount || 0) < 2) failures.push("rpc-redundancy-required");
  if (input?.operationalReady !== true) failures.push("runtime-not-ready");
  if (input?.evidenceJournalReady !== true) failures.push("evidence-journal-not-ready");
  if (Number(input?.recoverySkippedBlocks || 0) > 0) failures.push("paper-recovery-gaps-present");
  return {
    eligibleForMicroMainnet: failures.length === 0,
    failures,
    policy,
    progress: {
      paperTrades: Number(paper.closedTrades || 0),
      paperTradesRemaining: Math.max(0, policy.minPaperTrades - Number(paper.closedTrades || 0)),
      paperExpectancyPerTrade: Number(paper.expectancyPerTrade || 0),
      paperDrawdownPct,
      shadowUniquePools: Number(shadow.uniquePools || 0),
      paperUniquePools: Number(paper.uniquePools || 0),
      paperMeasurementFailures: Number(paper.measurementFailures || 0),
      recoverySkippedBlocks: Number(input?.recoverySkippedBlocks || 0),
    },
  };
}
