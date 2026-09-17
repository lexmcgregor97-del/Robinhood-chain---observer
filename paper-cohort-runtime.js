const errorMessage = (error) => (error instanceof Error ? error.message : String(error));

export function createAsyncReadCache(read) {
  if (typeof read !== "function") throw new Error("read-function-required");
  const cache = new Map();
  let activeScope;
  return async (scope, method, params) => {
    if (scope !== activeScope) {
      cache.clear();
      activeScope = scope;
    }
    const key = JSON.stringify([scope, method, params]);
    if (!cache.has(key)) {
      const pending = Promise.resolve().then(() => read(method, params));
      cache.set(key, pending);
      pending.catch(() => cache.delete(key));
    }
    return cache.get(key);
  };
}

export async function runIsolatedCohortStage(cohorts, operation, {
  stage,
  globallyBlocked = () => false,
} = {}) {
  if (!Array.isArray(cohorts) || typeof operation !== "function") {
    throw new Error("invalid-cohort-stage");
  }
  const results = new Map();
  for (const cohort of cohorts) {
    try {
      const value = await operation(cohort);
      results.set(cohort.strategyVersion, { ok: true, value });
    } catch (error) {
      cohort.automation.lastError = errorMessage(error);
      cohort.automation.stageFailures ||= {};
      cohort.automation.stageFailures[stage || "unknown"]
        = Number(cohort.automation.stageFailures[stage || "unknown"] || 0) + 1;
      results.set(cohort.strategyVersion, { ok: false, error: errorMessage(error) });
      // A journal/checkpoint failure is global. Isolation must never permit
      // more in-memory mutations after durable persistence blocks.
      if (globallyBlocked()) throw error;
    }
  }
  return results;
}

export function recordCohortMeasurement(automation, candidates) {
  automation.measurementCycles = Number(automation.measurementCycles || 0) + 1;
  automation.candidatesMeasured = Number(automation.candidatesMeasured || 0)
    + (Array.isArray(candidates) ? candidates.length : 0);
}

export function recordCohortRejection(automation, reasons) {
  automation.entryAttempts = Number(automation.entryAttempts || 0) + 1;
  automation.rejectionReasons ||= {};
  for (const reason of new Set((reasons || []).filter(Boolean))) {
    automation.rejectionReasons[reason]
      = Number(automation.rejectionReasons[reason] || 0) + 1;
  }
}

export function recordCohortApproval(automation, pool) {
  automation.entryAttempts = Number(automation.entryAttempts || 0) + 1;
  automation.entryApprovals = Number(automation.entryApprovals || 0) + 1;
  automation.enteredPools ||= [];
  const normalized = String(pool || "").toLowerCase();
  if (normalized && !automation.enteredPools.includes(normalized)) {
    automation.enteredPools.push(normalized);
  }
}

export function recordFirstMark(automation, position, marked, at = Date.now()) {
  automation.firstMarks ||= [];
  const openedAt = Number(position?.openedAt);
  if (!position?.pool || !Number.isFinite(openedAt)
      || automation.firstMarks.some((item) => (
        item.pool === position.pool && item.openedAt === openedAt
      ))) return;
  automation.firstMarks.push({
    pool: position.pool,
    openedAt,
    markedAt: Number(at),
    entryReturnPct: Number(marked?.returnPct),
    executionCostPct: Number(position?.entryAudit?.executionCostPct),
  });
  if (automation.firstMarks.length > 10_000) automation.firstMarks.shift();
}

export function cohortComparison(control, candidate) {
  const controlPools = new Set(control?.enteredPools || []);
  const candidatePools = new Set(candidate?.enteredPools || []);
  return {
    controlUniquePools: controlPools.size,
    candidateUniquePools: candidatePools.size,
    overlappingUniquePools: [...controlPools].filter((pool) => candidatePools.has(pool)).length,
  };
}
