const FINAL = new Set(["confirmed", "reverted", "rejected", "operator-rejected"]);

const count = (typeCounts, type) => Number(typeCounts?.[type] || 0);
const recordsById = (records = []) => new Map(records.map((record) => [record?.intentId, record]));

export function executionPendingCount(execution = {}) {
  const records = execution?.journal?.records || [];
  return records.filter((record) => record?.intentId && !FINAL.has(record.status)).length;
}

export function validateExecutionCheckpoint({ execution = {}, typeCounts = {} } = {}) {
  const journal = execution.journal || {};
  const nonceLane = execution.nonceLane || {};
  const spendLedger = execution.spendLedger || {};
  const livePositions = execution.livePositions || {};
  const transitionCount = Number(journal.transitionCount || 0);
  const nonceMutationCount = Number(nonceLane.mutationCount || 0);
  const spendMutationCount = Number(spendLedger.mutationCount || 0);
  const positionMutationCount = Number(livePositions.mutationCount || 0);
  if (![transitionCount, nonceMutationCount, spendMutationCount, positionMutationCount]
    .every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error("execution-checkpoint-invalid");
  }
  if (transitionCount !== count(typeCounts, "execution-transition")
      + count(typeCounts, "execution-operator-rejected")) {
    throw new Error("execution-journal-evidence-divergence");
  }
  if (nonceMutationCount !== count(typeCounts, "execution-nonce-reserved")
      + count(typeCounts, "execution-nonce-finalized")) {
    throw new Error("execution-nonce-evidence-divergence");
  }
  if (spendMutationCount !== count(typeCounts, "execution-spend-recorded")) {
    throw new Error("execution-spend-evidence-divergence");
  }
  if (positionMutationCount !== count(typeCounts, "live-position-opened")
      + count(typeCounts, "live-position-marked")
      + count(typeCounts, "live-position-exit-requested")
      + count(typeCounts, "live-position-exit-cancelled")
      + count(typeCounts, "live-position-closed")) {
    throw new Error("live-position-evidence-divergence");
  }

  const records = recordsById(journal.records || []);
  if (records.size !== (journal.records || []).length || records.has(undefined)
      || transitionCount < records.size) {
    throw new Error("execution-journal-state-invalid");
  }
  const spendIntentIds = spendLedger.intentIds || [];
  if (new Set(spendIntentIds).size !== spendIntentIds.length
      || spendMutationCount < spendIntentIds.length) {
    throw new Error("execution-spend-state-invalid");
  }
  for (const intentId of spendIntentIds) {
    const record = records.get(intentId);
    if (!record || record.status === "rejected") {
      throw new Error("execution-spend-journal-divergence");
    }
  }
  const pendingLanes = (nonceLane.lanes || []).filter((lane) => lane?.pending);
  const laneKeys = (nonceLane.lanes || []).map((lane) => lane?.key);
  if (new Set(laneKeys).size !== laneKeys.length || laneKeys.includes(undefined)
      || nonceMutationCount < (nonceLane.lanes || []).length) {
    throw new Error("execution-nonce-state-invalid");
  }
  const pendingIntentIds = new Set();
  for (const lane of pendingLanes) {
    const intentId = lane.pending?.intentId;
    if (!intentId || pendingIntentIds.has(intentId) || !records.has(intentId)) {
      throw new Error("execution-nonce-journal-divergence");
    }
    pendingIntentIds.add(intentId);
  }
  for (const record of records.values()) {
    if (new Set(["nonce-reserved", "signing-requested", "signed", "rebroadcast-requested",
      "broadcast"]).has(record.status)
        && !pendingIntentIds.has(record.intentId)) {
      throw new Error("execution-journal-nonce-divergence");
    }
  }
  return true;
}
