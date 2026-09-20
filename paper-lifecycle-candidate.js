import {
  PAPER_CONTROL_RISK_POLICY,
  PAPER_CONTROL_STRATEGY,
} from "./paper-control-policy.js";

export const PAPER_LIFECYCLE_CANDIDATE_VERSION
  = "2026-09-20-paper-signal-conditioned-lifecycle-v3";

// Entry selection is identical to the v7 control. The candidate changes only
// sizing and lifecycle behavior. It is registered only in the isolated paper
// cohort; the live worker does not import or execute this policy.
export const PAPER_LIFECYCLE_CANDIDATE_RISK_POLICY = Object.freeze({
  ...PAPER_CONTROL_RISK_POLICY,
});

export const PAPER_LIFECYCLE_CANDIDATE_STRATEGY = Object.freeze({
  ...PAPER_CONTROL_STRATEGY,
  // The lifecycle planner below owns exits; disable inherited price-only
  // controls so status output cannot imply that they remain active.
  stopLossPct: null,
  takeProfitPct: null,
  maxHoldMs: null,
  riskBudgetPct: 0.4,
  maximumEntryCashPct: 5,
  // Explicit candidate safety threshold. This must not be inherited from the
  // control because lifecycle holding depends on continuously verified exits.
  liquidityCollapseImpactPct: 5,
  deepLiquidityImpactPct: 0.5,
  deepLiquidityAdverseBoundaryPct: 20,
  standardLiquidityAdverseBoundaryPct: 30,
  trailingActivationPct: 20,
  trailingDrawdownPct: 12,
  volatilityTrailMultiplier: 2,
  maximumTrailingDrawdownPct: 30,
  weakeningPartialProfitPct: 20,
  partialCloseFraction: 0.5,
  absoluteMaxHoldMs: 24 * 60 * 60_000,
});

const strictFinite = (value) => typeof value === "number" && Number.isFinite(value);
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

export function validatePaperLifecyclePolicy(policy) {
  const positive = [
    "liquidityCollapseImpactPct", "riskBudgetPct", "maximumEntryCashPct",
    "deepLiquidityImpactPct", "deepLiquidityAdverseBoundaryPct",
    "standardLiquidityAdverseBoundaryPct",
    "trailingActivationPct", "trailingDrawdownPct", "volatilityTrailMultiplier",
    "maximumTrailingDrawdownPct", "weakeningPartialProfitPct", "absoluteMaxHoldMs",
  ];
  if (!policy || positive.some((key) => !strictFinite(policy[key]) || policy[key] <= 0)
      || !strictFinite(policy.partialCloseFraction)
      || policy.partialCloseFraction <= 0 || policy.partialCloseFraction >= 1
      || policy.maximumTrailingDrawdownPct < policy.trailingDrawdownPct
      || policy.standardLiquidityAdverseBoundaryPct
        < policy.deepLiquidityAdverseBoundaryPct
      || policy.liquidityCollapseImpactPct <= policy.deepLiquidityImpactPct
      || policy.maximumEntryCashPct > 100) {
    throw new Error("invalid-lifecycle-policy");
  }
  return policy;
}

export function lifecycleTelemetry(previous = {}, returnPct) {
  const current = Number(returnPct);
  if (!Number.isFinite(current)) throw new Error("invalid-lifecycle-return");
  const priorFavorable = previous.maxFavorableExcursionPct;
  const priorAdverse = previous.maxAdverseExcursionPct;
  if ((priorFavorable !== undefined && !strictFinite(priorFavorable))
      || (priorAdverse !== undefined && !strictFinite(priorAdverse))) {
    throw new Error("invalid-lifecycle-telemetry");
  }
  return {
    maxFavorableExcursionPct: Math.max(priorFavorable ?? current, current),
    maxAdverseExcursionPct: Math.min(priorAdverse ?? current, current),
  };
}

export function estimateObservedVolatilityPct(prices, {
  windowSize = 12,
  minimumReturns = 4,
} = {}) {
  if (!Array.isArray(prices) || !Number.isInteger(windowSize) || windowSize < 2
      || !Number.isInteger(minimumReturns) || minimumReturns < 2
      || minimumReturns >= windowSize) return null;
  const window = prices.slice(-windowSize);
  if (window.some((price) => !strictFinite(price) || price <= 0)) return null;
  const returns = window.slice(1).map((price, index) => (
    Math.log(price / window[index]) * 100
  ));
  if (returns.length < minimumReturns) return null;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + ((value - mean) ** 2), 0)
    / returns.length;
  const volatility = Math.sqrt(variance);
  return Number.isFinite(volatility) ? volatility : null;
}

export function adaptiveTrailingDrawdownPct(
  volatilityPct,
  policy = PAPER_LIFECYCLE_CANDIDATE_STRATEGY,
) {
  const base = Number(policy.trailingDrawdownPct);
  const maximum = Number(policy.maximumTrailingDrawdownPct);
  const multiplier = Number(policy.volatilityTrailMultiplier);
  if (![base, maximum, multiplier].every(Number.isFinite)
      || base <= 0 || maximum < base || multiplier <= 0) {
    throw new Error("invalid-adaptive-trail-policy");
  }
  if (!strictFinite(volatilityPct) || volatilityPct < 0) return base;
  return clamp(volatilityPct * multiplier, base, maximum);
}

export function assessPositionSignal(
  { signal = {}, marketSafety = {} } = {},
  policy = PAPER_LIFECYCLE_CANDIDATE_STRATEGY,
) {
  validatePaperLifecyclePolicy(policy);
  if (marketSafety.liquidityZero === true || marketSafety.activeLiquidityZero === true) {
    return { state: "emergency", reasons: ["liquidity-zero"] };
  }
  if (marketSafety.liquidityKnown !== true || marketSafety.sellMathOk !== true) {
    return { state: "emergency", reasons: ["sellability-unverified"] };
  }
  if (marketSafety.sellProbe && marketSafety.sellProbe.passed !== true) {
    return { state: "emergency", reasons: ["sell-probe-failed"] };
  }
  const impact = Number(marketSafety.priceImpactPct);
  if (!Number.isFinite(impact)) {
    return { state: "emergency", reasons: ["exit-impact-unavailable"] };
  }
  if (impact >= policy.liquidityCollapseImpactPct) {
    return { state: "emergency", reasons: ["liquidity-collapse"] };
  }

  const swaps = Number(signal.swapsCurrentWindow);
  const acceleration = Number(signal.acceleration);
  if (!Number.isFinite(swaps) || !Number.isFinite(acceleration)) {
    return { state: "invalidated", reasons: ["signal-unavailable"] };
  }
  if (signal.state === "quiet" || swaps < 2 || acceleration < 0.35) {
    return { state: "invalidated", reasons: ["activity-invalidated"] };
  }

  const flow = signal.adaptiveFlow || {};
  const flowReady = flow.ready === true;
  const buyShare = Number(flow.buyShare);
  const volumeMultiple = Number(flow.volumeMultiple);
  const reasons = [];
  if (flowReady && Number.isFinite(buyShare) && buyShare < 0.45) {
    reasons.push("sell-flow-dominant");
  }
  if (acceleration < 0.75) reasons.push("activity-weakening");
  if (flowReady && Number.isFinite(volumeMultiple) && volumeMultiple < 0.75) {
    reasons.push("volume-weakening");
  }
  if (reasons.length) return { state: "weakening", reasons };

  const strengthening = signal.state === "breakout-watch"
    || signal.state === "escape-velocity"
    || (flowReady && Number.isFinite(volumeMultiple) && volumeMultiple >= 2
      && Number.isFinite(buyShare) && buyShare >= 0.6);
  return { state: strengthening ? "strengthening" : "healthy", reasons: [] };
}

export function adverseBoundaryPct(
  exitPriceImpactPct,
  policy = PAPER_LIFECYCLE_CANDIDATE_STRATEGY,
) {
  validatePaperLifecyclePolicy(policy);
  if (!strictFinite(exitPriceImpactPct) || exitPriceImpactPct < 0) {
    throw new Error("invalid-exit-price-impact");
  }
  return exitPriceImpactPct <= policy.deepLiquidityImpactPct
    ? policy.deepLiquidityAdverseBoundaryPct
    : policy.standardLiquidityAdverseBoundaryPct;
}

export function signalConditionedEntryPlan({
  exitPriceImpactPct,
  policy = PAPER_LIFECYCLE_CANDIDATE_STRATEGY,
} = {}) {
  validatePaperLifecyclePolicy(policy);
  const entryAdverseBoundaryPct = adverseBoundaryPct(exitPriceImpactPct, policy);
  return {
    entryAdverseBoundaryPct,
    entryCashPct: Math.min(
      policy.maximumEntryCashPct,
      policy.riskBudgetPct * 100 / entryAdverseBoundaryPct,
    ),
    riskBudgetPct: policy.riskBudgetPct,
  };
}

export function signalConditionedEntryCashPct({
  exitPriceImpactPct,
  policy = PAPER_LIFECYCLE_CANDIDATE_STRATEGY,
} = {}) {
  return signalConditionedEntryPlan({ exitPriceImpactPct, policy }).entryCashPct;
}

export function planPaperLifecycleExit(
  position,
  now = Date.now(),
  policy = PAPER_LIFECYCLE_CANDIDATE_STRATEGY,
  assessment = position?.signalAssessment,
) {
  validatePaperLifecyclePolicy(policy);
  const returnPct = Number(position?.returnPct);
  const peakReturnPct = Number(position?.peakReturnPct ?? returnPct);
  const openedAt = Number(position?.openedAt);
  const heldMs = Number(now) - openedAt;
  if (![returnPct, peakReturnPct, openedAt, heldMs].every(Number.isFinite)) return null;
  if (!assessment || !["strengthening", "healthy", "weakening", "invalidated", "emergency"]
    .includes(assessment.state)) {
    return { reason: "signal-assessment-unavailable", closeFraction: 1 };
  }
  if (assessment.state === "emergency") {
    return { reason: assessment.reasons?.[0] || "market-safety-emergency", closeFraction: 1 };
  }
  if (assessment.state === "invalidated") {
    return { reason: "signal-invalidated", closeFraction: 1 };
  }

  const boundary = Number(position?.entryAdverseBoundaryPct);
  const permittedBoundaries = [
    policy.deepLiquidityAdverseBoundaryPct,
    policy.standardLiquidityAdverseBoundaryPct,
  ];
  if (!Number.isFinite(boundary) || !permittedBoundaries.includes(boundary)) {
    return { reason: "entry-risk-boundary-unavailable", closeFraction: 1 };
  }
  if (returnPct <= -boundary) {
    return {
      reason: "volatility-risk-boundary",
      closeFraction: 1,
      entryBoundaryPct: boundary,
      appliedBoundaryPct: boundary,
    };
  }

  // Price alone never takes profit while the signal remains healthy.
  if (assessment.state !== "weakening") {
    if (heldMs >= policy.absoluteMaxHoldMs) {
      return { reason: "absolute-max-hold", closeFraction: 1 };
    }
    return null;
  }

  if (returnPct >= policy.weakeningPartialProfitPct
      && position?.partialProfitTaken !== true) {
    return { reason: "signal-weakening-partial", closeFraction: policy.partialCloseFraction };
  }
  const trailWidthPct = adaptiveTrailingDrawdownPct(position?.observedVolatilityPct, policy);
  if (peakReturnPct >= policy.trailingActivationPct
      && peakReturnPct - returnPct >= trailWidthPct) {
    return {
      reason: "signal-weakening-trail",
      closeFraction: 1,
      trailWidthPct,
      observedMarkIntervalMs: position?.observedMarkIntervalMs ?? null,
    };
  }
  if (heldMs >= policy.absoluteMaxHoldMs) {
    return { reason: "absolute-max-hold", closeFraction: 1 };
  }
  return null;
}

export function updateStopCounterfactuals(previous = {}, returnPct) {
  const current = Number(returnPct);
  if (!Number.isFinite(current)) throw new Error("invalid-counterfactual-return");
  const next = structuredClone(previous);
  for (const threshold of [8, 15, 20, 30]) {
    const key = String(threshold);
    const item = next[key] || { breached: false, recoveredToBreakEven: false };
    if (current <= -threshold) item.breached = true;
    if (item.breached && current >= 0) item.recoveredToBreakEven = true;
    next[key] = item;
  }
  return next;
}

export const PAPER_LIFECYCLE_CANDIDATE_HYPOTHESIS = Object.freeze({
  changed: Object.freeze([
    "control-entry-signals-only",
    "risk-budgeted-one-point-three-to-two-percent-sizing",
    "entry-sizing-reduces-per-position-deployed-cash",
    "entry-time-twenty-or-thirty-percent-adverse-boundary-never-widens",
    "explicit-five-percent-liquidity-collapse-emergency",
    "no-price-only-profit-taking-while-signal-is-healthy",
    "partial-profit-only-after-signal-weakening",
    "twelve-to-thirty-percent-volatility-trail-only-after-signal-weakening",
    "volatility-trail-assumes-two-times-per-mark-sigma-and-records-mark-cadence",
    "eight-fifteen-twenty-thirty-percent-stop-counterfactuals",
    "mfe-and-mae-telemetry",
  ]),
  preserved: Object.freeze([
    "paper-only",
    "same-entry-signals-as-v7-control",
    "same-entry-safety-as-v7-control",
    "exact-sell-proof",
    "gas-estimate",
    "three-concurrent-positions",
    "ten-percent-portfolio-drawdown-circuit",
  ]),
  activation: Object.freeze({
    runtimeEnabled: true,
    cohortRegistered: true,
    currentCohortUnchanged: true,
    promotionAutomatic: false,
    requiresFreshIsolatedCohort: true,
    liveExecutionSupported: false,
  }),
});
