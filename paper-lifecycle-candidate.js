import {
  PAPER_FREQUENCY_CANDIDATE_RISK_POLICY,
  PAPER_FREQUENCY_CANDIDATE_STRATEGY,
} from "./paper-frequency-candidate.js";

export const PAPER_LIFECYCLE_CANDIDATE_VERSION
  = "2026-09-17-paper-lifecycle-candidate-v1";

// This candidate deliberately preserves the frequency candidate's entry gates.
// It changes position management only, so a future paired cohort can attribute
// outcome differences to the lifecycle rather than to opportunity selection.
export const PAPER_LIFECYCLE_CANDIDATE_RISK_POLICY = Object.freeze({
  ...PAPER_FREQUENCY_CANDIDATE_RISK_POLICY,
});

export const PAPER_LIFECYCLE_CANDIDATE_STRATEGY = Object.freeze({
  ...PAPER_FREQUENCY_CANDIDATE_STRATEGY,
  catastropheStopPct: 18,
  trailingActivationPct: 8,
  trailingDrawdownPct: 6,
  volatilityTrailMultiplier: 1.5,
  maximumTrailingDrawdownPct: 12,
  partialTakeProfitPct: 20,
  partialCloseFraction: 0.5,
  finalTakeProfitPct: 50,
  stagnationAfterMs: 15 * 60_000,
  stagnationMinimumPeakPct: 3,
  stagnationMaximumReturnPct: 1,
  maxHoldMs: 90 * 60_000,
});

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

const strictFinite = (value) => typeof value === "number" && Number.isFinite(value);

export function validatePaperLifecyclePolicy(policy) {
  const positive = [
    "liquidityCollapseImpactPct", "catastropheStopPct", "trailingActivationPct",
    "trailingDrawdownPct", "volatilityTrailMultiplier", "maximumTrailingDrawdownPct",
    "partialTakeProfitPct", "finalTakeProfitPct", "stagnationAfterMs",
    "stagnationMinimumPeakPct", "maxHoldMs",
  ];
  const finiteOnly = ["stagnationMaximumReturnPct"];
  if (!policy || positive.some((key) => !strictFinite(policy[key]) || policy[key] <= 0)
      || finiteOnly.some((key) => !strictFinite(policy[key]))) {
    throw new Error("invalid-lifecycle-policy");
  }
  if (!strictFinite(policy.partialCloseFraction)
      || policy.partialCloseFraction <= 0 || policy.partialCloseFraction >= 1
      || policy.maximumTrailingDrawdownPct < policy.trailingDrawdownPct
      || policy.finalTakeProfitPct <= policy.partialTakeProfitPct
      || policy.maxHoldMs < policy.stagnationAfterMs) {
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

export function planPaperLifecycleExit(
  position,
  now = Date.now(),
  policy = PAPER_LIFECYCLE_CANDIDATE_STRATEGY,
) {
  validatePaperLifecyclePolicy(policy);
  const returnPct = Number(position?.returnPct);
  const peakReturnPct = Number(position?.peakReturnPct ?? returnPct);
  const openedAt = Number(position?.openedAt);
  const heldMs = Number(now) - openedAt;
  if (![returnPct, peakReturnPct, openedAt, heldMs].every(Number.isFinite)) return null;

  const exitPriceImpactPct = Number(position?.exitPriceImpactPct);
  if (Number.isFinite(exitPriceImpactPct)
      && exitPriceImpactPct >= Number(policy.liquidityCollapseImpactPct)) {
    return { reason: "liquidity-collapse", closeFraction: 1 };
  }
  if (returnPct <= -Number(policy.catastropheStopPct)) {
    return { reason: "catastrophe-stop", closeFraction: 1 };
  }
  if (returnPct >= Number(policy.finalTakeProfitPct)) {
    return { reason: "final-take-profit", closeFraction: 1 };
  }
  const trailWidthPct = adaptiveTrailingDrawdownPct(position?.observedVolatilityPct, policy);
  if (peakReturnPct >= Number(policy.trailingActivationPct)
      && peakReturnPct - returnPct >= trailWidthPct) {
    return { reason: "adaptive-trailing-stop", closeFraction: 1, trailWidthPct };
  }

  if (returnPct >= Number(policy.partialTakeProfitPct)
      && position?.partialProfitTaken !== true) {
    return {
      reason: "partial-take-profit",
      closeFraction: policy.partialCloseFraction,
    };
  }

  if (heldMs >= Number(policy.stagnationAfterMs)
      && peakReturnPct < Number(policy.stagnationMinimumPeakPct)
      && returnPct <= Number(policy.stagnationMaximumReturnPct)) {
    return { reason: "stagnation-time-stop", closeFraction: 1 };
  }
  if (heldMs >= Number(policy.maxHoldMs)) {
    return { reason: "max-hold", closeFraction: 1 };
  }
  return null;
}

export const PAPER_LIFECYCLE_CANDIDATE_HYPOTHESIS = Object.freeze({
  changed: Object.freeze([
    "eighteen-percent-catastrophe-stop",
    "trail-activates-after-eight-percent-gain",
    "volatility-adaptive-six-to-twelve-percent-trail",
    "fifty-percent-profit-taken-at-twenty-percent-return",
    "protective-trail-precedes-partial-profit",
    "fifteen-minute-stagnation-exit",
    "ninety-minute-maximum-hold",
    "mfe-and-mae-telemetry",
  ]),
  preserved: Object.freeze([
    "paper-only",
    "same-entry-signals-as-frequency-candidate",
    "same-entry-cadence-as-frequency-candidate",
    "exact-sell-proof",
    "gas-estimate",
    "five-percent-sizing",
    "three-concurrent-positions",
    "ten-percent-portfolio-drawdown-circuit",
  ]),
  activation: Object.freeze({
    runtimeEnabled: false,
    currentCohortUnchanged: true,
    promotionAutomatic: false,
  }),
});
