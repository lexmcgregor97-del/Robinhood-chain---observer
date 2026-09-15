import test from "node:test";
import assert from "node:assert/strict";
import {
  executionPendingCount, validateExecutionCheckpoint,
} from "./execution-checkpoint.js";

const execution = {
  journal: { transitionCount: 3, records: [
    { intentId: "done", status: "confirmed" },
    { intentId: "pending", status: "signed" },
  ] },
  nonceLane: { mutationCount: 1, lanes: [{ key: "4663:wallet",
    pending: { intentId: "pending", nonce: 2 } }] },
  spendLedger: { mutationCount: 2, day: "2026-09-15", spent: { weth: "2" },
    intentIds: ["done", "pending"] },
};
const typeCounts = { "execution-transition": 3, "execution-nonce-reserved": 1,
  "execution-spend-recorded": 2 };

test("accepts matching execution evidence and restored ownership", () => {
  assert.equal(validateExecutionCheckpoint({ execution, typeCounts }), true);
  assert.equal(executionPendingCount(execution), 1);
});

test("rejects a missing transition, nonce, or spend evidence record", () => {
  assert.throws(() => validateExecutionCheckpoint({ execution,
    typeCounts: { ...typeCounts, "execution-transition": 2 } }), /journal-evidence/);
  assert.throws(() => validateExecutionCheckpoint({ execution,
    typeCounts: { ...typeCounts, "execution-nonce-reserved": 0 } }), /nonce-evidence/);
  assert.throws(() => validateExecutionCheckpoint({ execution,
    typeCounts: { ...typeCounts, "execution-spend-recorded": 1 } }), /spend-evidence/);
});

test("rejects orphaned spend and nonce ownership", () => {
  assert.throws(() => validateExecutionCheckpoint({ execution: {
    ...execution, spendLedger: { ...execution.spendLedger, intentIds: ["missing"] },
  }, typeCounts }), /spend-journal/);
  assert.throws(() => validateExecutionCheckpoint({ execution: {
    ...execution, nonceLane: { ...execution.nonceLane, lanes: [{
      key: "4663:wallet",
      pending: { intentId: "missing", nonce: 2 },
    }] },
  }, typeCounts }), /nonce-journal/);
});

test("rejects a signed journal record without its durable nonce reservation", () => {
  assert.throws(() => validateExecutionCheckpoint({ execution: {
    ...execution, nonceLane: { mutationCount: 1, lanes: [] },
  }, typeCounts }), /journal-nonce/);
});
