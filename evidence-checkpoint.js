import { validateExecutionCheckpoint } from "./execution-checkpoint.js";

const ZERO_HASH = "0".repeat(64);

export function paperLedgerTradeCount(paperBooks = {}) {
  return Object.values(paperBooks || {}).reduce(
    (sum, saved) => sum + Number(saved?.state?.trades?.length || 0), 0,
  );
}

export function paperJournalRecordCount(typeCounts = {}) {
  return Number(typeCounts?.["paper-open"] || 0)
    + Number(typeCounts?.["paper-partial-close"] || 0)
    + Number(typeCounts?.["paper-close"] || 0);
}

export function frequencyCandidateJournalRecordCount(typeCounts = {}, version = "") {
  if (!version) return 0;
  return Number(typeCounts?.[`${version}-open`] || 0)
    + Number(typeCounts?.[`${version}-partial-close`] || 0)
    + Number(typeCounts?.[`${version}-close`] || 0);
}

export function validateResearchCohortCheckpoints(cohorts = {}, typeCounts = {}) {
  for (const [name, cohort] of Object.entries(cohorts || {})) {
    if (!cohort?.version || !cohort?.books) {
      throw new Error(`research-cohort-checkpoint-invalid:${name}`);
    }
    if (paperLedgerTradeCount(cohort.books)
        !== frequencyCandidateJournalRecordCount(typeCounts, cohort.version)) {
      throw new Error(`research-cohort-evidence-ledger-divergence:${name}`);
    }
  }
  return true;
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
  if (paperLedgerTradeCount(state?.frequencyCandidateBooks)
      !== frequencyCandidateJournalRecordCount(
        journal?.typeCounts, state?.frequencyCandidateVersion,
      )) {
    throw new Error("frequency-candidate-evidence-ledger-divergence");
  }
  validateResearchCohortCheckpoints(state?.paperResearchCohorts, journal?.typeCounts);
  validateExecutionCheckpoint({ execution: state?.execution,
    typeCounts: journal?.typeCounts });
  return true;
}
