import test from "node:test";
import assert from "node:assert/strict";
import { PaperPortfolio } from "./paper-portfolio.js";
import {
  PAPER_LIFECYCLE_COHORT_BOUNDARY,
  applyCompletedEpochBlock,
  applyLifecyclePaperMark,
  assertCompletedCohortsClosed,
  completedEpochCycleDisposition,
  lifecycleSizingCashPcts,
  researchCohortRestoreStatus,
  selectExactLifecycleMeasurement,
} from "./paper-lifecycle-cohort.js";

const measured = (exitPriceImpactPct) => ({
  marketSafety: { exitPriceImpactPct },
});

test("selects only a measurement self-consistent with its exact size", () => {
  assert.deepEqual(lifecycleSizingCashPcts(), { deep: 2, standard: 4 / 3 });
  const deep = measured(0.4);
  assert.deepEqual(selectExactLifecycleMeasurement({ deep }), {
    eligible: true, boundary: "deep", candidate: deep,
  });
  const standard = measured(0.8);
  assert.deepEqual(selectExactLifecycleMeasurement({ deep: measured(0.7), standard }), {
    eligible: true, boundary: "standard", candidate: standard,
  });
  assert.equal(selectExactLifecycleMeasurement({
    deep: measured(0.7), standard: measured(0.4),
  }).reason, "sizing-boundary-instability");
});

test("records a lifecycle mark before applying an exact-unit partial", async () => {
  const book = new PaperPortfolio({ initialCash: 100 });
  book.open({ pool: "pool", token: "token", price: 1, quantity: 10,
    quantityUnits: "100", notional: 10, timestamp: 1,
    entryAdverseBoundaryPct: 20 });
  const position = book.snapshot().openPositions[0];
  const result = await applyLifecyclePaperMark({
    portfolio: book,
    position,
    marked: { markPrice: 1.3, returnPct: 30, peakReturnPct: 30 },
    signal: { state: "active", swapsCurrentWindow: 4, acceleration: 0.5 },
    marketSafety: { liquidityKnown: true, sellMathOk: true, priceImpactPct: 0.5 },
    timestamp: 10,
    fullExit: { executionPrice: 1.3, proceeds: 13 },
    quotePartial: async (quantityUnits) => {
      assert.equal(quantityUnits, "50");
      assert.equal(book.snapshot().openPositions[0].lastLifecycleMarkAt, 10);
      return { executionPrice: 1.3, proceeds: 6.5 };
    },
  });
  assert.equal(result.evidenceType, "partial-close");
  assert.equal(result.trade.quantityUnits, "50");
  assert.equal(result.trade.audit.exitUnitsAndProceedsAuthoritative, true);
  assert.equal(result.trade.audit.executionPriceDerivedForDisplay, true);
  assert.equal(book.snapshot().openPositions[0].partialProfitTaken, true);
});

test("a failed partial quote retains the mark and no partial trade", async () => {
  const book = new PaperPortfolio({ initialCash: 100 });
  book.open({ pool: "pool", token: "token", price: 1, quantity: 10,
    quantityUnits: "100", notional: 10, timestamp: 1,
    entryAdverseBoundaryPct: 20 });
  const input = {
    portfolio: book,
    position: book.snapshot().openPositions[0],
    marked: { markPrice: 1.3, returnPct: 30, peakReturnPct: 30 },
    signal: { state: "active", swapsCurrentWindow: 4, acceleration: 0.5 },
    marketSafety: { liquidityKnown: true, sellMathOk: true, priceImpactPct: 0.5 },
    timestamp: 10,
    fullExit: { executionPrice: 1.3, proceeds: 13 },
    quotePartial: async () => { throw new Error("partial-quote-failed"); },
  };
  await assert.rejects(applyLifecyclePaperMark(input), /partial-quote-failed/);
  assert.equal(book.snapshot().openPositions[0].lastLifecycleMarkAt, 10);
  assert.equal(book.serialize().trades.filter(
    (trade) => trade.type === "partial-close",
  ).length, 0);
  const next = await applyLifecyclePaperMark({
    ...input,
    position: book.snapshot().openPositions[0],
    marked: { markPrice: 1.1, returnPct: 10, peakReturnPct: 30 },
    signal: { state: "active", swapsCurrentWindow: 4, acceleration: 1 },
    timestamp: 20,
  });
  assert.equal(next.trade, null);
  assert.equal(book.snapshot().openPositions[0].lastLifecycleMarkAt, 20);
});

test("a final boundary exit records mark and applied risk evidence", async () => {
  const book = new PaperPortfolio({ initialCash: 100 });
  book.open({ pool: "pool", token: "token", price: 1, quantity: 10,
    quantityUnits: "100", notional: 10, timestamp: 1,
    entryAdverseBoundaryPct: 20 });
  const result = await applyLifecyclePaperMark({
    portfolio: book,
    position: book.snapshot().openPositions[0],
    marked: { markPrice: 0.8, returnPct: -20, peakReturnPct: 0 },
    signal: { state: "active", swapsCurrentWindow: 4, acceleration: 1 },
    marketSafety: { liquidityKnown: true, sellMathOk: true, priceImpactPct: 1 },
    timestamp: 10,
    fullExit: { executionPrice: 0.8, proceeds: 8 },
  });
  assert.equal(result.evidenceType, "close");
  assert.equal(result.trade.appliedBoundaryPct, 20);
  assert.equal(result.trade.audit.entryAdverseBoundaryPct, 20);
  assert.equal(book.snapshot().openPositions.length, 0);
});

test("paired cohort support remains paper-only", () => {
  assert.deepEqual(PAPER_LIFECYCLE_COHORT_BOUNDARY, {
    pairedPaperRuntimeSupported: true,
    liveExecutionSupported: false,
    automaticPromotion: false,
  });
});

test("a completed epoch must be flat before the fresh pair can run", () => {
  assert.equal(assertCompletedCohortsClosed([
    { openPositions: [] }, { openPositions: [] },
  ]), true);
  assert.throws(() => assertCompletedCohortsClosed([
    { openPositions: [{ pool: "legacy-open" }] },
  ]), /completed-paper-epoch-has-open-positions/);
});

test("a legacy freeze violation blocks entries but preserves lifecycle exits", () => {
  assert.deepEqual(completedEpochCycleDisposition([
    { openPositions: [{ pool: "legacy-open" }] },
  ]), {
    manageLifecycleExits: true,
    allowEntries: false,
    blockReason: "completed-paper-epoch-not-flat",
    detail: "completed-paper-epoch-has-open-positions",
  });
});

test("a durability block outranks a concurrent legacy freeze violation", () => {
  const persistence = { automationBlockedReason: "evidence-journal-failed" };
  const disposition = completedEpochCycleDisposition([
    { openPositions: [{ pool: "legacy-open" }] },
  ]);
  assert.equal(applyCompletedEpochBlock(persistence, disposition),
    "evidence-journal-failed");
  assert.equal(persistence.automationBlockedReason, "evidence-journal-failed");
  const unblocked = { automationBlockedReason: null };
  assert.equal(applyCompletedEpochBlock(unblocked, disposition),
    "completed-paper-epoch-not-flat");
});

test("checkpoint restore status exposes absent and version-mismatched cohorts", () => {
  assert.deepEqual(researchCohortRestoreStatus(undefined, "v2"), {
    restoredFromCheckpoint: false, reason: "checkpoint-absent", savedVersion: null,
  });
  assert.deepEqual(researchCohortRestoreStatus({ version: "v1", books: {} }, "v2"), {
    restoredFromCheckpoint: false, reason: "version-mismatch", savedVersion: "v1",
  });
  assert.deepEqual(researchCohortRestoreStatus({ version: "v2", books: {} }, "v2"), {
    restoredFromCheckpoint: true, reason: "restored", savedVersion: "v2",
  });
});
