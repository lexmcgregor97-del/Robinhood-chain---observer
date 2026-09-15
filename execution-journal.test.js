import test from "node:test";
import assert from "node:assert/strict";
import { ExecutionJournal } from "./execution-journal.js";

const hash = `0x${"12".repeat(32)}`;

test("round-trips pending execution records", async () => {
  const journal = new ExecutionJournal();
  await journal.transition("entry:1", { status: "reserved", valueWei: "10" }, 1);
  await journal.transition("entry:1", { status: "signed", transactionHash: hash }, 2);
  const restored = new ExecutionJournal(journal.snapshot());
  assert.equal(restored.pending()[0].transactionHash, hash);
});

test("does not mutate memory when durable persistence fails", async () => {
  const journal = new ExecutionJournal({}, { persist: async () => { throw new Error("disk-full"); } });
  await assert.rejects(journal.transition("entry:1", { status: "reserved" }, 1), /disk-full/);
  assert.equal(journal.get("entry:1"), null);
});

test("final records cannot transition again", async () => {
  const journal = new ExecutionJournal();
  await journal.transition("entry:1", { status: "confirmed", transactionHash: hash }, 1);
  await assert.rejects(journal.transition("entry:1", { status: "broadcast" }, 2), /already-final/);
});

test("preflight rejections are final evidence, not pending execution", async () => {
  const journal = new ExecutionJournal();
  await journal.transition("entry:rejected", { status: "rejected", stage: "preflight",
    failures: ["policy-drift"] }, 1);
  assert.deepEqual(journal.pending(), []);
  await assert.rejects(journal.transition("entry:rejected", { status: "reserved" }, 2),
    /already-final/);
});

test("serializes evidence checkpoints across different intents", async () => {
  const snapshots = [];
  const journal = new ExecutionJournal({}, { persist: async (state) => {
    await Promise.resolve();
    snapshots.push(state);
  } });
  await Promise.all([
    journal.transition("entry:1", { status: "reserved" }, 1),
    journal.transition("entry:2", { status: "reserved" }, 2),
  ]);
  assert.equal(snapshots[0].transitionCount, 1);
  assert.equal(snapshots[0].records.length, 1);
  assert.equal(snapshots[1].transitionCount, 2);
  assert.equal(snapshots[1].records.length, 2);
});
