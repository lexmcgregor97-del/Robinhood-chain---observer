import { DEFAULT_PAPER_STRATEGY } from "./paper-strategy.js";
import { PAPER_FREQUENCY_CANDIDATE_RISK_POLICY } from "./paper-frequency-candidate.js";

export const PAPER_LIFECYCLE_CANDIDATE_VERSION
  = "2026-09-17-paper-lifecycle-candidate-v1";

// This candidate deliberately preserves the frequency candidate's entry gates.
// It changes position management only, so a future paired cohort can attribute
// outcome differences to the lifecycle rather than to opportunity selection.
export const PAPER_LIFECYCLE_CANDIDATE_RISK_POLICY = Object.freeze({
  ...PAPER_FREQUENCY_CANDIDATE_RISK_POLICY,
});

export const PAPER_LIFECYCLE_CANDIDATE_STRATEGY = Object.freeze({
  ...DEFAULT_PAPER_STRATEGY,
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

const finite = (value) => Number.isFinite(Number(value));
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

export function lifecycleTelemetry(previous = {}, returnPct) {
  const current = Number(returnPct);
  if (!Number.isFinite(current)) throw new Error("invalid-lifecycle-return");
  return {
    maxFavorableExcursionPct: Math.max(
      Number(previous.maxFavorableExcursionPct || 0), current,
    ),
    maxAdverseExcursionPct: Math.min(
      Number(previous.maxAdverseExcursionPct || 0), current,
    ),
  };
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
  if (!finite(volatilityPct) || Number(volatilityPct) < 0) return base;
  return clamp(Number(volatilityPct) * multiplier, base, maximum);
}

export function planPaperLifecycleExit(
  position,
  now = Date.now(),
  policy = PAPER_LIFECYCLE_CANDIDATE_STRATEGY,
) {
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
  if (returnPct >= Number(policy.partialTakeProfitPct)
      && position?.partialProfitTaken !== true) {
    return {
      reason: "partial-take-profit",
      closeFraction: Number(policy.partialCloseFraction),
    };
  }

  const trailWidthPct = adaptiveTrailingDrawdownPct(position?.observedVolatilityPct, policy);
  if (peakReturnPct >= Number(policy.trailingActivationPct)
      && peakReturnPct - returnPct >= trailWidthPct) {
    return { reason: "adaptive-trailing-stop", closeFraction: 1, trailWidthPct };
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
    "fifteen-minute-stagnation-exit",
    "ninety-minute-maximum-hold",
    "mfe-and-mae-telemetry",
  ]),
  preserved: Object.freeze([
    "paper-only",
    "same-entry-signals-as-frequency-candidate",
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
