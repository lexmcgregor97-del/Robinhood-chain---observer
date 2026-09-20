import {
  PAPER_LIFECYCLE_CANDIDATE_STRATEGY,
  assessPositionSignal,
  estimateObservedVolatilityPct,
  planPaperLifecycleExit,
  signalConditionedEntryPlan,
} from "./paper-lifecycle-candidate.js";
import { planPaperEntry } from "./paper-strategy.js";

// Caller ordering contract for any future cohort:
// 1. prepareLifecycleMark; 2. portfolio.recordLifecycleMark(result.record);
// 3. only then apply result.close. Skipping or reordering step 2 invalidates
// monotonic-clock evidence and must fail the cohort stage.

export const PAPER_LIFECYCLE_WIRING_BOUNDARY = Object.freeze({
  runtimeEnabled: false,
  cohortRegistered: false,
  liveExecutionSupported: false,
});

export function prepareLifecyclePaperEntry(
  candidate,
  portfolio,
  now = Date.now(),
  policy = PAPER_LIFECYCLE_CANDIDATE_STRATEGY,
) {
  const entry = signalConditionedEntryPlan({
    exitPriceImpactPct: candidate?.marketSafety?.exitPriceImpactPct,
    policy,
  });
  // Exact executable evidence must be measured at the risk-budgeted size.
  // Never scale a fill that was simulated for the control's larger notional.
  const base = planPaperEntry(candidate, portfolio, {
    ...policy,
    entryCashPct: entry.entryCashPct,
  }, now);
  if (!base.approved) return base;
  return {
    approved: true,
    order: {
      ...base.order,
      entryAdverseBoundaryPct: entry.entryAdverseBoundaryPct,
    },
    lifecycleRisk: entry,
  };
}

export function prepareLifecycleMark({
  position,
  marked,
  signal,
  marketSafety,
  timestamp,
  policy = PAPER_LIFECYCLE_CANDIDATE_STRATEGY,
} = {}) {
  const at = Number(timestamp);
  if (!Number.isFinite(at) || at < 0
      || (position?.lastLifecycleMarkAt !== undefined
        && at <= Number(position.lastLifecycleMarkAt))) {
    throw new Error("invalid-lifecycle-mark-clock");
  }
  const observedPrices = [...(position?.observedPrices || []), Number(marked?.markPrice)];
  const observedVolatilityPct = estimateObservedVolatilityPct(observedPrices);
  const assessment = assessPositionSignal({ signal, marketSafety }, policy);
  const decisionPosition = {
    ...position,
    ...marked,
    observedVolatilityPct,
    observedMarkIntervalMs: position?.lastLifecycleMarkAt === undefined
      ? null : at - Number(position.lastLifecycleMarkAt),
  };
  const decision = planPaperLifecycleExit(decisionPosition, at, policy, assessment);
  return {
    timestamp: at,
    recordBeforeClose: true,
    assessment,
    observedVolatilityPct,
    record: {
      returnPct: Number(marked?.returnPct),
      observedPrice: Number(marked?.markPrice),
      timestamp: at,
    },
    decision,
    close: decision ? {
      reason: decision.reason,
      closeFraction: decision.closeFraction,
      appliedBoundaryPct: decision.appliedBoundaryPct ?? null,
      audit: {
        signalState: assessment.state,
        signalReasons: [...(assessment.reasons || [])],
        entryAdverseBoundaryPct: position?.entryAdverseBoundaryPct ?? null,
        appliedBoundaryPct: decision.appliedBoundaryPct ?? null,
        trailWidthPct: decision.trailWidthPct ?? null,
        observedMarkIntervalMs: decisionPosition.observedMarkIntervalMs,
      },
    } : null,
  };
}
