import { DEFAULT_PAPER_POLICY } from "./risk-gate.js";
import { PAPER_LIFECYCLE_CANDIDATE_STRATEGY } from "./paper-lifecycle-candidate.js";

export const PAPER_OPPORTUNITY_CANDIDATE_VERSION = "2026-09-21-paper-opportunity-v1";

export const PAPER_OPPORTUNITY_CANDIDATE_RISK_POLICY = Object.freeze({
  ...DEFAULT_PAPER_POLICY,
  maxPriceImpactPct: 1.5,
  maxExecutionCostPct: 4,
  requireGasEstimate: true,
  requireSellProbe: true,
  allowedSignals: Object.freeze(["active", "breakout-watch", "escape-velocity"]),
  minSwaps: 3,
  minAcceleration: 0.6,
  maxAcceleration: 12,
});

export const PAPER_OPPORTUNITY_CANDIDATE_STRATEGY = Object.freeze({
  ...PAPER_LIFECYCLE_CANDIDATE_STRATEGY,
  entryWindowMs: 6 * 60 * 60_000,
});

export const PAPER_OPPORTUNITY_CANDIDATE_HYPOTHESIS = Object.freeze({
  changed: Object.freeze([
    "active-breakout-watch-or-escape-velocity",
    "three-swaps-per-minute",
    "0.6-to-12x-acceleration",
    "top-25-v2-direct-quote-candidates",
  ]),
  preserved: Object.freeze([
    "paper-only",
    "v2-only-until-exact-v3-sell-proof-exists",
    "exact-sell-proof",
    "gas-estimate",
    "1.5-percent-price-impact",
    "4-percent-execution-cost",
    "five-percent-spot-swap-deviation",
    "five-minute-pool-age",
    "three-concurrent-positions",
    "ten-percent-portfolio-drawdown-circuit",
    "signal-conditioned-lifecycle",
  ]),
  activation: Object.freeze({
    runtimeEnabled: true,
    isolatedPaperCohort: true,
    automaticPromotion: false,
    liveExecutionSupported: false,
  }),
});
