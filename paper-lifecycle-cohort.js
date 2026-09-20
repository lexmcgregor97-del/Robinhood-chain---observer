import {
  PAPER_LIFECYCLE_CANDIDATE_STRATEGY,
  signalConditionedEntryPlan,
} from "./paper-lifecycle-candidate.js";
import { prepareLifecycleMark } from "./paper-lifecycle-wiring.js";
import { floorPartialQuantityUnits } from "./paper-portfolio.js";

export const PAPER_LIFECYCLE_CONTROL_VERSION
  = "2026-09-20-paper-lifecycle-control-v1";

export const PAPER_LIFECYCLE_COHORT_BOUNDARY = Object.freeze({
  pairedPaperRuntimeSupported: true,
  liveExecutionSupported: false,
  automaticPromotion: false,
});

export function assertCompletedCohortsClosed(states = []) {
  if (!Array.isArray(states) || states.some((state) => (
    !state || !Array.isArray(state.openPositions)
  ))) throw new Error("invalid-completed-cohort-state");
  if (states.some((state) => state.openPositions.length > 0)) {
    throw new Error("completed-paper-epoch-has-open-positions");
  }
  return true;
}

export function completedEpochCycleDisposition(states = []) {
  try {
    assertCompletedCohortsClosed(states);
    return Object.freeze({
      manageLifecycleExits: true,
      allowEntries: true,
      blockReason: null,
      detail: null,
    });
  } catch (error) {
    return Object.freeze({
      manageLifecycleExits: true,
      allowEntries: false,
      blockReason: "completed-paper-epoch-not-flat",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

export function applyCompletedEpochBlock(persistence, disposition) {
  if (!persistence || typeof persistence !== "object"
      || !disposition || typeof disposition !== "object") {
    throw new Error("invalid-completed-epoch-block-state");
  }
  if (!disposition.allowEntries) {
    persistence.automationBlockedReason ||= disposition.blockReason;
  }
  return persistence.automationBlockedReason || null;
}

export function researchCohortRestoreStatus(saved, expectedVersion) {
  if (!saved) return Object.freeze({
    restoredFromCheckpoint: false,
    reason: "checkpoint-absent",
    savedVersion: null,
  });
  if (saved.version !== expectedVersion) return Object.freeze({
    restoredFromCheckpoint: false,
    reason: "version-mismatch",
    savedVersion: saved.version ?? null,
  });
  if (!saved.books) return Object.freeze({
    restoredFromCheckpoint: false,
    reason: "checkpoint-invalid",
    savedVersion: saved.version,
  });
  return Object.freeze({
    restoredFromCheckpoint: true,
    reason: "restored",
    savedVersion: saved.version,
  });
}

export function lifecycleSizingCashPcts(
  policy = PAPER_LIFECYCLE_CANDIDATE_STRATEGY,
) {
  const deep = signalConditionedEntryPlan({
    exitPriceImpactPct: 0,
    policy,
  }).entryCashPct;
  const standard = signalConditionedEntryPlan({
    exitPriceImpactPct: policy.deepLiquidityImpactPct + Number.EPSILON,
    policy,
  }).entryCashPct;
  return { deep, standard };
}

export function selectExactLifecycleMeasurement({ deep, standard } = {},
  policy = PAPER_LIFECYCLE_CANDIDATE_STRATEGY) {
  const deepImpact = Number(deep?.marketSafety?.exitPriceImpactPct);
  if (!Number.isFinite(deepImpact) || deepImpact < 0) {
    return { eligible: false, reason: "deep-exit-impact-unavailable" };
  }
  if (deepImpact <= policy.deepLiquidityImpactPct) {
    return { eligible: true, boundary: "deep", candidate: deep };
  }
  const standardImpact = Number(standard?.marketSafety?.exitPriceImpactPct);
  if (!Number.isFinite(standardImpact) || standardImpact < 0) {
    return { eligible: false, reason: "standard-exit-impact-unavailable" };
  }
  if (standardImpact <= policy.deepLiquidityImpactPct) {
    return { eligible: false, reason: "sizing-boundary-instability" };
  }
  return { eligible: true, boundary: "standard", candidate: standard };
}

const finiteNonNegative = (value, reason) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(reason);
  return number;
};

function fillEvidence(fill) {
  const proceeds = finiteNonNegative(fill?.proceeds, "lifecycle-exit-proceeds-unavailable");
  const executionPrice = finiteNonNegative(
    fill?.executionPrice,
    "lifecycle-exit-price-unavailable",
  );
  return { ...fill, proceeds, executionPrice };
}

export async function applyLifecyclePaperMark({
  portfolio,
  position,
  marked,
  signal,
  marketSafety,
  timestamp,
  fullExit,
  quotePartial,
  feeRate = 0,
  gasCost = 0,
  audit = {},
  policy = PAPER_LIFECYCLE_CANDIDATE_STRATEGY,
} = {}) {
  if (!portfolio || typeof portfolio.recordLifecycleMark !== "function") {
    throw new Error("lifecycle-portfolio-required");
  }
  const prepared = prepareLifecycleMark({
    position, marked, signal, marketSafety, timestamp, policy,
  });
  // This mutation must precede either partial or final close so the monotonic
  // mark clock and counterfactual evidence cannot be skipped by an exit.
  portfolio.recordLifecycleMark(position.pool, prepared.record);
  if (!prepared.close) return { prepared, trade: null, evidenceType: null };

  feeRate = finiteNonNegative(feeRate, "invalid-lifecycle-fee-rate");
  gasCost = finiteNonNegative(gasCost, "invalid-lifecycle-gas-cost");
  const closeAudit = { ...audit, ...prepared.close.audit };
  if (prepared.close.closeFraction < 1) {
    if (typeof quotePartial !== "function") {
      throw new Error("lifecycle-partial-quote-required");
    }
    const quantityUnits = floorPartialQuantityUnits(
      position.quantityUnits,
      prepared.close.closeFraction,
    );
    const fill = fillEvidence(await quotePartial(quantityUnits));
    const trade = portfolio.partialClose({
      pool: position.pool,
      quantityUnits,
      price: fill.executionPrice,
      proceeds: fill.proceeds,
      fee: fill.proceeds * feeRate,
      gasCost,
      timestamp,
      reason: prepared.close.reason,
      audit: {
        ...closeAudit,
        exitUnitsAndProceedsAuthoritative: true,
        executionPriceDerivedForDisplay: true,
      },
    });
    return { prepared, trade, evidenceType: "partial-close" };
  }

  const fill = fillEvidence(fullExit);
  const trade = portfolio.close({
    pool: position.pool,
    price: fill.executionPrice,
    proceeds: fill.proceeds,
    fee: fill.proceeds * feeRate,
    gasCost,
    timestamp,
    reason: prepared.close.reason,
    appliedBoundaryPct: prepared.close.appliedBoundaryPct,
    audit: closeAudit,
  });
  return { prepared, trade, evidenceType: "close" };
}
