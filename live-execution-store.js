import { EvidenceJournal } from "./evidence-journal.js";
import { validateExecutionCheckpoint } from "./execution-checkpoint.js";
import { ExecutionJournal } from "./execution-journal.js";
import { createExecutionMutationSerializer } from "./execution-mutation-queue.js";
import { NonceLane } from "./nonce-lane.js";
import { DailySpendLedger } from "./spend-ledger.js";
import { loadJsonState, saveJsonState } from "./state-store.js";
import { executionRecoveryLockPresent } from "./execution-recovery-lock.js";
import { LivePositionLedger } from "./live-position-ledger.js";

const ZERO_HASH = "0".repeat(64);

export async function openLiveExecutionStore({ statePath, evidencePath,
  now = Date.now, lockPresent = executionRecoveryLockPresent } = {}) {
  if (!statePath || !evidencePath || typeof now !== "function") {
    throw new Error("live-execution-store-paths-required");
  }
  if (await lockPresent(statePath)) throw new Error("execution-recovery-lock-present");
  const evidence = new EvidenceJournal(evidencePath);
  await evidence.initialize();
  let state = await loadJsonState(statePath);
  if (!state) {
    if (evidence.snapshot().sequence !== 0) throw new Error("live-evidence-state-divergence");
    state = { liveWorkerVersion: 1, execution: {}, evidenceSequence: 0,
      evidenceLastHash: ZERO_HASH };
  }
  if (state.liveWorkerVersion !== 1) throw new Error("live-execution-state-invalid");
  const evidenceSnapshot = evidence.snapshot();
  if (Number(state.evidenceSequence || 0) !== evidenceSnapshot.sequence
      || String(state.evidenceLastHash || ZERO_HASH) !== evidenceSnapshot.lastHash) {
    throw new Error("live-evidence-state-divergence");
  }
  validateExecutionCheckpoint({ execution: state.execution,
    typeCounts: evidenceSnapshot.typeCounts });

  let writeBlocked = false;
  const serialize = createExecutionMutationSerializer();
  let journal;
  let nonceLane;
  let spendLedger;
  let livePositions;
  const persist = async (_snapshot, event) => {
    if (writeBlocked) throw new Error("live-execution-store-write-blocked");
    try {
      if (await lockPresent(statePath)) throw new Error("execution-recovery-lock-present");
      await evidence.append({ epoch: "live-worker-v1", recordedAt: Number(now()), ...event });
      state.execution = { journal: journal.snapshot(), nonceLane: nonceLane.snapshot(),
        spendLedger: spendLedger.snapshot(Number(now())), livePositions: livePositions.snapshot() };
      state.evidenceSequence = evidence.snapshot().sequence;
      state.evidenceLastHash = evidence.snapshot().lastHash;
      await saveJsonState(statePath, state);
      state = await loadJsonState(statePath);
    } catch (error) {
      writeBlocked = true;
      throw error;
    }
  };
  journal = new ExecutionJournal(state.execution?.journal, { persist, serialize });
  nonceLane = new NonceLane(state.execution?.nonceLane, { persist, serialize });
  spendLedger = new DailySpendLedger(state.execution?.spendLedger, { persist, serialize });
  livePositions = new LivePositionLedger(state.execution?.livePositions, { persist, serialize });
  return Object.freeze({ journal, nonceLane, spendLedger, livePositions, evidence,
    get writeBlocked() { return writeBlocked; },
    snapshot() { return Object.freeze({ execution: {
      journal: journal.snapshot(), nonceLane: nonceLane.snapshot(),
      spendLedger: spendLedger.snapshot(Number(now())), livePositions: livePositions.snapshot(),
    }, evidenceSequence: evidence.snapshot().sequence,
    evidenceLastHash: evidence.snapshot().lastHash }); },
  });
}
