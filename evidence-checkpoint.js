import { validateExecutionCheckpoint } from "./execution-checkpoint.js";

const ZERO_HASH = "0".repeat(64);

export function paperLedgerTradeCount(paperBooks = {}) {
  return Object.values(paperBooks || {}).reduce(
    (sum, saved) => sum + Number(saved?.state?.trades?.length || 0), 0,
  );
}

export function paperJournalRecordCount(typeCounts = {}) {
  return Number(typeCounts?.["paper-open"] || 0)
    + Number(typeCounts?.["paper-close"] || 0);
}

export function validateEvidenceCheckpoint({ state, journal }) {
  const stateSequence = Number(state?.evidenceSequence || 0);
  const journalSequence = Number(journal?.sequence || 0);
  if (stateSequence !== journalSequence) throw new Error("evidence-state-divergence");
  const stateHash = String(state?.evidenceLastHash
    || (stateSequence === 0 ? ZERO_HASH : ""));
  if (stateHash !== String(journal?.lastHash || "")) {
    throw new Error("evidence-hash-divergence");
  }
  if (paperLedgerTradeCount(state?.paperBooks)
      !== paperJournalRecordCount(journal?.typeCounts)) {
    throw new Error("evidence-ledger-divergence");
  }
  validateExecutionCheckpoint({ execution: state?.execution,
    typeCounts: journal?.typeCounts });
  return true;
}
