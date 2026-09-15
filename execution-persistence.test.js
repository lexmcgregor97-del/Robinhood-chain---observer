import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EvidenceJournal } from "./evidence-journal.js";
import { validateEvidenceCheckpoint } from "./evidence-checkpoint.js";
import { ExecutionJournal } from "./execution-journal.js";
import { NonceLane } from "./nonce-lane.js";
import { DailySpendLedger } from "./spend-ledger.js";
import { loadJsonState, saveJsonState } from "./state-store.js";
import { createExecutionMutationSerializer } from "./execution-mutation-queue.js";

const walletAddress = "0x1111111111111111111111111111111111111111";

test("execution mutations survive restart with evidence-count reconciliation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atlas-execution-persistence-"));
  try {
    const evidencePath = join(dir, "evidence.jsonl");
    const statePath = join(dir, "state.json");
    const evidence = new EvidenceJournal(evidencePath);
    await evidence.initialize();
    let journal;
    let nonceLane;
    let spendLedger;
    const persist = async (_snapshot, event) => {
      await evidence.append(event);
      await saveJsonState(statePath, {
        paperBooks: {},
        execution: { journal: journal.snapshot(), nonceLane: nonceLane.snapshot(),
          spendLedger: spendLedger.snapshot() },
        evidenceSequence: evidence.snapshot().sequence,
        evidenceLastHash: evidence.snapshot().lastHash,
      });
    };
    journal = new ExecutionJournal({}, { persist });
    nonceLane = new NonceLane({}, { persist });
    spendLedger = new DailySpendLedger({}, { persist });

    await spendLedger.record({ intentId: "entry:1", asset: "weth", amount: "10" });
    await journal.transition("entry:1", { status: "reserved" }, 1);
    await nonceLane.reserve({ chainId: 4663, walletAddress, intentId: "entry:1" },
      async () => 7);
    await journal.transition("entry:1", { status: "nonce-reserved", nonce: 7 }, 2);

    const restartedEvidence = new EvidenceJournal(evidencePath);
    await restartedEvidence.initialize();
    const state = await loadJsonState(statePath);
    assert.equal(validateEvidenceCheckpoint({ state,
      journal: restartedEvidence.snapshot() }), true);
    const restoredJournal = new ExecutionJournal(state.execution.journal);
    const restoredNonce = new NonceLane(state.execution.nonceLane);
    const restoredSpend = new DailySpendLedger(state.execution.spendLedger);
    assert.equal(restoredJournal.pending()[0].status, "nonce-reserved");
    assert.equal(restoredNonce.snapshot().lanes[0].pending.nonce, 7);
    assert.equal(restoredSpend.snapshot().spent.weth, "10");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("evidence ahead of a failed state checkpoint blocks the next restore", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atlas-execution-divergence-"));
  try {
    const evidence = new EvidenceJournal(join(dir, "evidence.jsonl"));
    await evidence.initialize();
    const journal = new ExecutionJournal({}, { persist: async (_snapshot, event) => {
      await evidence.append(event);
      throw new Error("state-write-failed");
    } });
    await assert.rejects(journal.transition("entry:1", { status: "reserved" }),
      /state-write-failed/);
    assert.equal(journal.get("entry:1"), null);
    assert.throws(() => validateEvidenceCheckpoint({ state: {
      paperBooks: {}, evidenceSequence: 0, evidenceLastHash: "0".repeat(64),
      execution: { journal: journal.snapshot(), nonceLane: {}, spendLedger: {} },
    }, journal: evidence.snapshot() }), /evidence-state-divergence/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("one serializer prevents cross-component mutations leaking into earlier checkpoints", async () => {
  const checkpoints = [];
  const serialize = createExecutionMutationSerializer();
  let journal;
  let nonceLane;
  let spendLedger;
  const persist = async (_snapshot, event) => {
    await Promise.resolve();
    checkpoints.push({ type: event.type, journal: journal.snapshot().transitionCount,
      nonce: nonceLane.snapshot().mutationCount,
      spend: spendLedger.snapshot().mutationCount });
  };
  journal = new ExecutionJournal({}, { persist, serialize });
  nonceLane = new NonceLane({}, { persist, serialize });
  spendLedger = new DailySpendLedger({}, { persist, serialize });
  await Promise.all([
    journal.transition("entry:1", { status: "reserved" }),
    spendLedger.record({ intentId: "entry:1", asset: "weth", amount: "10" }),
    nonceLane.reserve({ chainId: 4663, walletAddress, intentId: "entry:1" }, async () => 7),
  ]);
  assert.deepEqual(checkpoints, [
    { type: "execution-transition", journal: 1, nonce: 0, spend: 0 },
    { type: "execution-spend-recorded", journal: 1, nonce: 0, spend: 1 },
    { type: "execution-nonce-reserved", journal: 1, nonce: 1, spend: 1 },
  ]);
});
