import { DEFAULT_PAPER_POLICY } from "./risk-gate.js";
import { DEFAULT_PAPER_STRATEGY } from "./paper-strategy.js";

export const PAPER_FREQUENCY_CANDIDATE_VERSION
  = "2026-09-17-paper-frequency-candidate-v1";

// This cohort changes opportunity selection only. Market safety, exact sell
// proof, sizing, drawdown, and exit controls remain identical to the v7 control.
export const PAPER_FREQUENCY_CANDIDATE_STRATEGY = Object.freeze({
  ...DEFAULT_PAPER_STRATEGY,
  maxHoldMs: 30 * 60_000,
  entryWindowMs: 6 * 60 * 60_000,
});

export const PAPER_FREQUENCY_CANDIDATE_RISK_POLICY = Object.freeze({
  ...DEFAULT_PAPER_POLICY,
  maxPriceImpactPct: 1.5,
  maxExecutionCostPct: 4,
  requireGasEstimate: true,
  requireSellProbe: true,
  allowedSignals: ["active", "breakout-watch"],
  minSwaps: 3,
  minAcceleration: 0.6,
  maxAcceleration: 3,
});

export const PAPER_FREQUENCY_CANDIDATE_HYPOTHESIS = Object.freeze({
  changed: Object.freeze([
    "active-or-breakout-watch-signal",
    "three-swaps-per-minute",
    "0.6-to-3x-acceleration",
    "three-entries-per-pool-per-six-hours",
  ]),
  preserved: Object.freeze([
    "paper-only",
    "v2-only",
    "five-percent-sizing",
    "three-concurrent-positions",
    "ten-percent-drawdown-circuit",
    "exact-sell-proof",
    "gas-estimate",
    "1.5-percent-price-impact",
    "4-percent-execution-cost",
    "5-percent-spot-swap-deviation",
    "five-minute-pool-age",
  ]),
  finishLine: Object.freeze({
    minimumObservationHours: 24,
    minimumUniquePools: 20,
    promotionAutomatic: false,
  }),
});
