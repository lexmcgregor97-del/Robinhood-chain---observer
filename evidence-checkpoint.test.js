import test from "node:test";
import assert from "node:assert/strict";
import { validateEvidenceCheckpoint } from "./evidence-checkpoint.js";

const hash = "a".repeat(64);
const state = (trades = [{ type: "open" }, { type: "close" }]) => ({
  evidenceSequence: 4,
  evidenceLastHash: hash,
  paperBooks: { weth: { state: { trades } } },
});
const journal = (overrides = {}) => ({
  sequence: 4,
  lastHash: hash,
  typeCounts: { "paper-open": 1, "paper-close": 1, "shadow-open": 2 },
  ...overrides,
});

test("accepts matching sequence, terminal hash, and paper record count", () => {
  assert.equal(validateEvidenceCheckpoint({ state: state(), journal: journal() }), true);
});

test("rejects terminal truncation even when a shorter chain is internally valid", () => {
  assert.throws(() => validateEvidenceCheckpoint({
    state: state(), journal: journal({ sequence: 3, lastHash: "b".repeat(64) }),
  }), /evidence-state-divergence/);
});

test("rejects a ledger mutation missing from the journal", () => {
  assert.throws(() => validateEvidenceCheckpoint({
    state: state([{ type: "open" }, { type: "close" }, { type: "open" }]),
    journal: journal(),
  }), /evidence-ledger-divergence/);
});
