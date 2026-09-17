import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PAPER_STRATEGY, MAX_PAPER_DRAWDOWN_PCT,
  planPaperEntry, paperEntryFailureDetails, paperExitReason, paperCircuitFailures,
} from "./paper-strategy.js";
import { DEFAULT_LIVE_PROMOTION_POLICY } from "./live-readiness.js";

const candidate = {
  address: "0xpool",
  riskGate: { eligibleForPaperEntry: true },
  marketSafety: {
    tokenPriceQuote: 2,
    baseToken: "0xtoken",
    baseTokenDecimals: 2,
    buyAmountOut: "4000",
    plannedNotionalQuote: 100,
  },
};

test("sizes paper entries from cash with a hard cap", () => {
  const plan = planPaperEntry(candidate, { cash: 1000, openPositions: [] },
    { ...DEFAULT_PAPER_STRATEGY, entryCashPct: 10 });
  assert.equal(plan.approved, true);
  assert.equal(plan.order.notional, 100);
  assert.equal(plan.order.quantity, 40);
  assert.equal(plan.order.midPrice, 2);
  assert.equal(plan.order.price, 2.5);
});

test("paper entry fails closed without risk approval or price", () => {
  const plan = planPaperEntry({ ...candidate, riskGate: { eligibleForPaperEntry: false },
    marketSafety: {
      tokenPriceQuote: null, baseTokenDecimals: 2, buyAmountOut: "4000",
    } }, { cash: 1000, openPositions: [] });
  assert.equal(plan.approved, false);
  assert.deepEqual(plan.failures, ["risk-gate-rejected", "price-unavailable"]);
});

test("reports the exact sanitized risk-gate reasons for rejected entries", () => {
  assert.deepEqual(paperEntryFailureDetails({
    riskGate: { failures: ["sell-probe-required", "execution-cost-too-high"] },
  }, ["risk-gate-rejected", "price-unavailable"]), [
    "sell-probe-required", "execution-cost-too-high", "price-unavailable",
  ]);
  assert.deepEqual(paperEntryFailureDetails({}, ["risk-gate-rejected"]),
    ["risk-gate-rejected"]);
});

test("prevents duplicate pool positions", () => {
  const plan = planPaperEntry(candidate, { cash: 1000, openPositions: [{ pool: "0xpool" }] });
  assert.equal(plan.approved, false);
  assert.ok(plan.failures.includes("position-already-open"));
});

test("treats a full paper book as a normal rejected entry", () => {
  const candidate = {
    address: "0xnew",
    riskGate: { eligibleForPaperEntry: true },
    marketSafety: {
      tokenPriceQuote: 1,
      baseToken: "0xtoken",
      baseTokenDecimals: 0,
      buyAmountOut: "10",
      plannedNotionalQuote: 10,
    },
  };
  const plan = planPaperEntry(candidate, {
    cash: 100,
    maxPositions: 1,
    openPositions: [{ pool: "0xexisting" }],
  }, { ...DEFAULT_PAPER_STRATEGY, entryCashPct: 10, maxEntryNotional: 10 });
  assert.equal(plan.approved, false);
  assert.ok(plan.failures.includes("position-limit-reached"));
});

test("blocks new entries at the realized drawdown limit", () => {
  assert.deepEqual(
    paperCircuitFailures({ maxRealizedDrawdownPct: 10 }),
    ["paper-drawdown-circuit-breaker"],
  );
  assert.deepEqual(paperCircuitFailures({ maxRealizedDrawdownPct: 9.99 }), []);
});

test("blocks new entries at the persisted marked drawdown limit", () => {
  assert.deepEqual(
    paperCircuitFailures({ maxRealizedDrawdownPct: 2, maxMarkedDrawdownPct: 10 }),
    ["paper-drawdown-circuit-breaker"],
  );
});

test("entry risk defaults match the live 10 percent drawdown gate", () => {
  assert.equal(MAX_PAPER_DRAWDOWN_PCT, 10);
  assert.equal(DEFAULT_PAPER_STRATEGY.maxRealizedDrawdownPct,
    DEFAULT_LIVE_PROMOTION_POLICY.maxPaperDrawdownPct);
  assert.equal(DEFAULT_PAPER_STRATEGY.entryCashPct, 5);
});

test("caps repeated entries into one pool within an epoch", () => {
  const portfolio = {
    cash: 1000,
    maxPositions: 3,
    openPositions: [],
    trades: [
      { type: "open", pool: "0xpool", timestamp: 1 },
      { type: "close", pool: "0xpool", timestamp: 2 },
      { type: "open", pool: "0xpool", timestamp: 3 },
      { type: "close", pool: "0xpool", timestamp: 4 },
      { type: "open", pool: "0xpool", timestamp: 5 },
      { type: "close", pool: "0xpool", timestamp: 6 },
    ],
  };
  const plan = planPaperEntry(candidate, portfolio, DEFAULT_PAPER_STRATEGY,
    20 * 60_000);
  assert.equal(plan.approved, false);
  assert.ok(plan.failures.includes("pool-epoch-entry-limit"));
});

test("rolling entry limit expires old pool entries without changing the epoch default", () => {
  const now = 10 * 60 * 60_000;
  const portfolio = {
    cash: 2000,
    maxPositions: 3,
    openPositions: [],
    trades: [
      { type: "open", pool: candidate.address, timestamp: now - 7 * 60 * 60_000 },
      { type: "open", pool: candidate.address, timestamp: now - 5 * 60 * 60_000 },
      { type: "open", pool: candidate.address, timestamp: now - 4 * 60 * 60_000 },
      { type: "open", pool: candidate.address, timestamp: now - 3 * 60 * 60_000 },
    ],
  };
  const rolling = planPaperEntry(candidate, portfolio, {
    ...DEFAULT_PAPER_STRATEGY,
    maxEntriesPerPool: 3,
    entryWindowMs: 6 * 60 * 60_000,
  }, now);
  assert.equal(rolling.approved, false);
  assert.ok(rolling.failures.includes("pool-window-entry-limit"));

  const afterExpiry = planPaperEntry(candidate, portfolio, {
    ...DEFAULT_PAPER_STRATEGY,
    maxEntriesPerPool: 3,
    entryWindowMs: 2 * 60 * 60_000,
  }, now);
  assert.equal(afterExpiry.approved, true);

  const epoch = planPaperEntry(candidate, portfolio, {
    ...DEFAULT_PAPER_STRATEGY,
    maxEntriesPerPool: 3,
  }, now);
  assert.equal(epoch.approved, false);
  assert.ok(epoch.failures.includes("pool-epoch-entry-limit"));
});

test("epoch entry limit still counts legacy opens without timestamps", () => {
  const portfolio = {
    cash: 2000,
    maxPositions: 3,
    openPositions: [],
    trades: [
      { type: "open", pool: candidate.address },
      { type: "open", pool: candidate.address, timestamp: "invalid" },
      { type: "open", pool: candidate.address, timestamp: 1 },
    ],
  };
  const epoch = planPaperEntry(candidate, portfolio, {
    ...DEFAULT_PAPER_STRATEGY,
    maxEntriesPerPool: 3,
  }, 100);
  assert.equal(epoch.approved, false);
  assert.ok(epoch.failures.includes("pool-epoch-entry-limit"));
});

test("drawdown circuit fails closed for invalid policy", () => {
  assert.deepEqual(
    paperCircuitFailures({ maxRealizedDrawdownPct: 1 }, { maxRealizedDrawdownPct: 0 }),
    ["invalid-drawdown-policy"],
  );
});

test("applies stop, target, trail and time exits deterministically", () => {
  const now = 1_000_000;
  assert.equal(paperExitReason({ returnPct: -8, openedAt: now }, now), "stop-loss");
  assert.equal(paperExitReason({ returnPct: 35, openedAt: now }, now), "take-profit");
  assert.equal(paperExitReason({ returnPct: 4, peakReturnPct: 11, openedAt: now }, now), "trailing-stop");
  assert.equal(paperExitReason({ returnPct: 1, openedAt: now - 6 * 60 * 60 * 1000 }, now), "max-hold");
  assert.equal(paperExitReason({ returnPct: 5, openedAt: now }, now), null);
});

test("labels an executable-liquidity collapse without hiding the realized loss", () => {
  const now = 1_000_000;
  assert.equal(paperExitReason({ returnPct: -93, peakReturnPct: 0,
    exitPriceImpactPct: 92.75, openedAt: now }, now), "liquidity-collapse");
});

test("paper entry fails closed without executable AMM output", () => {
  const plan = planPaperEntry({
    ...candidate,
    marketSafety: { tokenPriceQuote: 2, baseToken: "0xtoken" },
  }, { cash: 1000, openPositions: [] });
  assert.equal(plan.approved, false);
  assert.ok(plan.failures.includes("executable-fill-unavailable"));
});

test("paper entry rejects a fill simulated at a different size", () => {
  const plan = planPaperEntry({
    ...candidate,
    marketSafety: { ...candidate.marketSafety, plannedNotionalQuote: 10 },
  }, { cash: 1000, openPositions: [] });
  assert.equal(plan.approved, false);
  assert.ok(plan.failures.includes("fill-size-mismatch"));
});
