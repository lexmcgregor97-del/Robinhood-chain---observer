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

test("reconciles the isolated frequency-candidate ledger independently", () => {
  const state = {
    evidenceSequence: 2,
    evidenceLastHash: "a".repeat(64),
    paperBooks: {},
    frequencyCandidateVersion: "candidate-v1",
    frequencyCandidateBooks: {
      weth: { state: { trades: [{ type: "open" }, { type: "close" }] } },
    },
  };
  const journal = {
    sequence: 2,
    lastHash: "a".repeat(64),
    typeCounts: {
      "candidate-v1-open": 1,
      "candidate-v1-close": 1,
    },
  };
  assert.equal(validateEvidenceCheckpoint({ state, journal }), true);
  journal.typeCounts["candidate-v1-close"] = 0;
  assert.throws(() => validateEvidenceCheckpoint({ state, journal }),
    /frequency-candidate-evidence-ledger-divergence/);
});

test("reconciles partial-close records in control and candidate journals", () => {
  const checkpointState = {
    evidenceSequence: 6,
    evidenceLastHash: hash,
    paperBooks: { weth: { state: { trades: [
      { type: "open" }, { type: "partial-close" }, { type: "close" },
    ] } } },
    frequencyCandidateVersion: "candidate-v1",
    frequencyCandidateBooks: { weth: { state: { trades: [
      { type: "open" }, { type: "partial-close" }, { type: "close" },
    ] } } },
  };
  const checkpointJournal = {
    sequence: 6,
    lastHash: hash,
    typeCounts: {
      "paper-open": 1, "paper-partial-close": 1, "paper-close": 1,
      "candidate-v1-open": 1, "candidate-v1-partial-close": 1,
      "candidate-v1-close": 1,
    },
  };
  assert.equal(validateEvidenceCheckpoint({ state: checkpointState,
    journal: checkpointJournal }), true);
  checkpointJournal.typeCounts["candidate-v1-partial-close"] = 0;
  assert.throws(() => validateEvidenceCheckpoint({ state: checkpointState,
    journal: checkpointJournal }), /frequency-candidate-evidence-ledger-divergence/);
});

test("reconciles every named research cohort independently", () => {
  const checkpointState = {
    evidenceSequence: 4,
    evidenceLastHash: hash,
    paperBooks: {},
    paperResearchCohorts: {
      control: { version: "lifecycle-control-v1", books: {
        weth: { state: { trades: [{ type: "open" }, { type: "close" }] } },
      } },
      candidate: { version: "lifecycle-candidate-v1", books: {
        weth: { state: { trades: [{ type: "open" }, { type: "partial-close" }] } },
      } },
    },
  };
  const checkpointJournal = {
    sequence: 4,
    lastHash: hash,
    typeCounts: {
      "lifecycle-control-v1-open": 1,
      "lifecycle-control-v1-close": 1,
      "lifecycle-candidate-v1-open": 1,
      "lifecycle-candidate-v1-partial-close": 1,
    },
  };
  assert.equal(validateEvidenceCheckpoint({
    state: checkpointState, journal: checkpointJournal,
  }), true);
  checkpointJournal.typeCounts["lifecycle-candidate-v1-partial-close"] = 0;
  assert.throws(() => validateEvidenceCheckpoint({
    state: checkpointState, journal: checkpointJournal,
  }), /research-cohort-evidence-ledger-divergence:candidate/);
});

test("reconciles a complete lifecycle open, partial, and final close", () => {
  const state = {
    evidenceSequence: 3,
    evidenceLastHash: hash,
    paperBooks: {},
    paperResearchCohorts: {
      candidate: { version: "lifecycle-v3", books: {
        weth: { state: { trades: [
          { type: "open" }, { type: "partial-close" }, { type: "close" },
        ] } },
      } },
    },
  };
  const journal = {
    sequence: 3,
    lastHash: hash,
    typeCounts: {
      "lifecycle-v3-open": 1,
      "lifecycle-v3-partial-close": 1,
      "lifecycle-v3-close": 1,
    },
  };
  assert.equal(validateEvidenceCheckpoint({ state, journal }), true);
  delete journal.typeCounts["lifecycle-v3-partial-close"];
  assert.throws(() => validateEvidenceCheckpoint({ state, journal }),
    /research-cohort-evidence-ledger-divergence:candidate/);
});
