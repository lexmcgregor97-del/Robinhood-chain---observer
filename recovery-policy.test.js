import test from "node:test";
import assert from "node:assert/strict";
import {
  paperOpenPositionCount,
  paperCycleDuringRecovery,
  planLosslessRecovery,
  recoveryPaperCycleMode,
  recoveryBlockLimit,
} from "./recovery-policy.js";

test("a 308-block runtime lag scans all blocks without an eight-block jump", () => {
  const plan = planLosslessRecovery({ cursor: 1_000, latest: 1_308, maxBlocksPerPoll: 20_000 });
  assert.deepEqual(plan, {
    required: true,
    from: 1_001,
    to: 1_308,
    remainingBlocks: 0,
    skippedBlocks: 0,
  });
});

test("large recovery gaps are split into contiguous bounded scans", () => {
  const first = planLosslessRecovery({ cursor: 1_000, latest: 51_000, maxBlocksPerPoll: 20_000 });
  const second = planLosslessRecovery({ cursor: first.to, latest: 51_000, maxBlocksPerPoll: 20_000 });
  const third = planLosslessRecovery({ cursor: second.to, latest: 51_000, maxBlocksPerPoll: 20_000 });
  assert.equal(first.from, 1_001);
  assert.equal(second.from, first.to + 1);
  assert.equal(third.from, second.to + 1);
  assert.equal(third.to, 51_000);
  assert.equal(first.skippedBlocks + second.skippedBlocks + third.skippedBlocks, 0);
});

test("no scan is planned when the cursor is caught up", () => {
  assert.deepEqual(planLosslessRecovery({ cursor: 10, latest: 10, maxBlocksPerPoll: 20_000 }), {
    required: false,
    from: null,
    to: null,
    remainingBlocks: 0,
    skippedBlocks: 0,
  });
});

test("unsafe recovery inputs fail closed", () => {
  assert.throws(() => planLosslessRecovery({ cursor: -1, latest: 10, maxBlocksPerPoll: 20_000 }),
    /recovery-cursor-invalid/);
  assert.throws(() => planLosslessRecovery({ cursor: 1, latest: 10, maxBlocksPerPoll: 0 }),
    /recovery-limit-invalid/);
});

test("recovery permits only exit management for an open paper position", () => {
  assert.equal(recoveryPaperCycleMode({ synchronized: false, openPositions: 2 }), "exits-only");
  assert.equal(recoveryPaperCycleMode({ synchronized: false, openPositions: 0 }), "paused");
  assert.equal(recoveryPaperCycleMode({ synchronized: true, openPositions: 2 }), "full");
});

test("recovery sees positions held only by the lifecycle cohorts", () => {
  const openPositions = paperOpenPositionCount([
    { openPositions: [] },
    { openPositions: [] },
    { openPositions: [{ pool: "lifecycle-control" }] },
    { openPositions: [] },
  ]);
  assert.equal(openPositions, 1);
  assert.equal(recoveryPaperCycleMode({
    synchronized: false, openPositions,
  }), "exits-only");
});

test("exit audit provenance follows synchronization rather than cycle mode", () => {
  assert.equal(paperCycleDuringRecovery(true), false);
  assert.equal(paperCycleDuringRecovery(false), true);
  assert.throws(() => paperCycleDuringRecovery(undefined),
    /recovery-synchronization-state-invalid/);
});

test("invalid open-position counts fail closed", () => {
  assert.throws(() => recoveryPaperCycleMode({ synchronized: false, openPositions: -1 }),
    /recovery-open-positions-invalid/);
});

test("flat recovery converges against a moving chain without skipping blocks", () => {
  // Approximate the failed trial: 18,140 blocks behind, with 84 new blocks
  // arriving per scan. The old 100-block batch cannot catch up in 214 polls.
  let cursor = 1_000;
  let latest = cursor + 18_140;
  let polls = 0;
  while (cursor < latest && polls < 214) {
    const plan = planLosslessRecovery({ cursor, latest,
      maxBlocksPerPoll: recoveryBlockLimit(0) });
    assert.equal(plan.from, cursor + 1);
    assert.equal(plan.skippedBlocks, 0);
    cursor = plan.to;
    polls++;
    if (cursor < latest) latest += 84;
  }
  assert.equal(cursor, latest);
  assert.ok(polls < 50);
});

test("positions in any cohort retain small recovery batches and exit-only management", () => {
  for (let cohort = 0; cohort < 5; cohort++) {
    const states = Array.from({ length: 5 }, (_, i) => ({
      openPositions: i === cohort ? [{ pool: "open" }] : [],
    }));
    const count = paperOpenPositionCount(states);
    assert.equal(recoveryBlockLimit(count), 100);
    assert.equal(recoveryPaperCycleMode({ synchronized: false, openPositions: count }), "exits-only");
  }
  assert.throws(() => recoveryBlockLimit(NaN), /invalid/);
  assert.throws(() => recoveryBlockLimit(-1), /invalid/);
});
