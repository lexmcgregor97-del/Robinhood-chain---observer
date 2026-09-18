import { DEFAULT_PAPER_POLICY } from "./risk-gate.js";
import { DEFAULT_PAPER_STRATEGY } from "./paper-strategy.js";

// Canonical entry policy for the current v7 control. Dormant candidates import
// this object rather than copying the values from index.js and drifting away
// from the cohort they are intended to compare against.
export const PAPER_CONTROL_STRATEGY = Object.freeze({
  ...DEFAULT_PAPER_STRATEGY,
  maxHoldMs: 30 * 60_000,
});

export const PAPER_CONTROL_RISK_POLICY = Object.freeze({
  ...DEFAULT_PAPER_POLICY,
  maxPriceImpactPct: 1.5,
  maxExecutionCostPct: 4,
  requireGasEstimate: true,
  requireSellProbe: true,
  allowedSignals: ["active"],
  minSwaps: 4,
  minAcceleration: 0.75,
  maxAcceleration: 1.5,
});
