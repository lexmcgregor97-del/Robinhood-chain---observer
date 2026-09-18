import test from "node:test";
import assert from "node:assert/strict";
import { floorPartialQuantityUnits, PaperPortfolio } from "./paper-portfolio.js";
import { planPaperLifecycleExit } from "./paper-lifecycle-candidate.js";

test("tracks virtual entry, mark, and profitable exit", () => {
  const book = new PaperPortfolio({ initialCash: 100, maxPositions: 2 });
  book.open({ pool: "pool-a", token: "TOKEN", price: 2, notional: 20, fee: 1, timestamp: 1 });
  assert.equal(book.mark("pool-a", 3).unrealizedPnl, 8.5);
  const exit = book.close({ pool: "pool-a", price: 3, fee: 0.5, timestamp: 2 });
  assert.equal(exit.pnl, 8);
  assert.equal(book.snapshot().equity, 108);
});

test("prevents overspending and duplicate positions", () => {
  const book = new PaperPortfolio({ initialCash: 10 });
  assert.throws(() => book.open({ pool: "a", token: "A", price: 1, notional: 11 }), /insufficient/);
  book.open({ pool: "a", token: "A", price: 1, notional: 5 });
  assert.throws(() => book.open({ pool: "a", token: "A", price: 1, notional: 1 }), /already-open/);
});

test("round-trips serialized state", () => {
  const first = new PaperPortfolio({ initialCash: 100 });
  first.open({ pool: "a", token: "A", price: 2, notional: 20, timestamp: 1 });
  first.mark("a", 2.5);
  const restored = new PaperPortfolio({ initialCash: 100, state: first.serialize() });
  assert.deepEqual(restored.serialize(), first.serialize());
});

test("rejects malformed restored state", () => {
  assert.throws(() => new PaperPortfolio({ state: { mode: "LIVE", openPositions: [], trades: [] } }), /invalid-paper-state/);
});


test("tracks peak return for trailing exits", () => {
  const p = new PaperPortfolio({ initialCash: 1000 });
  p.open({ pool: "0xpeak", token: "TOK", price: 10, notional: 100 });
  p.mark("0xpeak", 15);
  const marked = p.mark("0xpeak", 13);
  assert.equal(marked.markPrice, 13);
  assert.equal(marked.peakPrice, 15);
  assert.equal(marked.peakReturnPct, 50);
});

test("preserves compact entry and exit audit metadata", () => {
  const book = new PaperPortfolio({ initialCash: 10 });
  book.open({
    pool: "audit-pool", token: "TOK", price: 2, notional: 2,
    audit: { block: 12, signal: "escape-velocity" },
  });
  assert.deepEqual(book.snapshot().openPositions[0].entryAudit,
    { block: 12, signal: "escape-velocity" });
  const trade = book.close({
    pool: "audit-pool", price: 2.5,
    audit: { block: 13, reason: "take-profit" },
  });
  assert.deepEqual(trade.audit, { block: 13, reason: "take-profit" });
  const restored = new PaperPortfolio({ initialCash: 10, state: book.serialize() });
  assert.deepEqual(restored.serialize(), book.serialize());
});

test("uses an explicit simulated fill quantity without subtracting the fee twice", () => {
  const book = new PaperPortfolio({ initialCash: 100 });
  const position = book.open({
    pool: "simulated", token: "TOK", price: 2.5, quantity: 8,
    notional: 20, fee: 0.05,
  });
  assert.equal(position.quantity, 8);
  assert.equal(position.costBasis, 20);
  assert.equal(book.snapshot().cash, 80);
});

test("credits explicit simulated exit proceeds without subtracting fees twice", () => {
  const book = new PaperPortfolio({ initialCash: 100 });
  book.open({ pool: "exit-fill", token: "TOK", price: 2, quantity: 10, notional: 20 });
  const trade = book.close({
    pool: "exit-fill", price: 1.8, proceeds: 18, fee: 0.04,
  });
  assert.equal(trade.proceeds, 18);
  assert.equal(trade.pnl, -2);
  assert.equal(book.snapshot().equity, 98);
});

test("can realize a confirmed worthless position at zero", () => {
  const book = new PaperPortfolio({ initialCash: 100 });
  book.open({ pool: "rug", token: "TOK", price: 2, quantity: 10, notional: 20 });
  const trade = book.close({
    pool: "rug", price: 0, proceeds: 0, reason: "liquidity-zero",
  });
  assert.equal(trade.pnl, -20);
  assert.equal(book.snapshot().equity, 80);
});

test("charges gas on both paper entry and exit", () => {
  const book = new PaperPortfolio({ initialCash: 1 });
  book.open({ pool: "gas", token: "token", price: 1, quantity: 0.1,
    notional: 0.1, gasCost: 0.01 });
  assert.ok(Math.abs(book.snapshot().cash - 0.89) < 1e-12);
  const closed = book.close({ pool: "gas", price: 1, proceeds: 0.1, gasCost: 0.01 });
  assert.ok(Math.abs(closed.pnl + 0.02) < 1e-12);
  assert.ok(Math.abs(book.snapshot().cash - 0.98) < 1e-12);
});

test("restore rejects a broken paper ledger invariant", () => {
  const book = new PaperPortfolio({ initialCash: 1 });
  const state = book.serialize();
  state.cash = 0.5;
  assert.throws(() => new PaperPortfolio({ initialCash: 1, state }),
    /paper-ledger-invariant-failed/);
});

test("partially closes exact units and allocates cost basis proportionally", () => {
  const book = new PaperPortfolio({ initialCash: 100 });
  book.open({ pool: "partial", token: "TOK", price: 2, quantity: 10,
    quantityUnits: "1000", notional: 20, timestamp: 1 });
  const partial = book.partialClose({ pool: "partial", quantityUnits: "500",
    price: 3, proceeds: 15, gasCost: 1, timestamp: 2,
    reason: "partial-take-profit" });
  assert.equal(partial.quantityUnits, "500");
  assert.equal(partial.remainingQuantityUnits, "500");
  assert.equal(partial.allocatedCostBasis, 10);
  assert.equal(partial.pnl, 4);
  const remaining = book.snapshot().openPositions[0];
  assert.equal(remaining.quantity, 5);
  assert.equal(remaining.quantityUnits, "500");
  assert.equal(remaining.costBasis, 10);
  assert.equal(remaining.partialProfitTaken, true);
  const final = book.close({ pool: "partial", price: 2.4, proceeds: 12,
    timestamp: 3, reason: "final-take-profit" });
  assert.equal(final.pnl, 2);
  assert.equal(final.partialProfitTaken, true);
  assert.equal(book.snapshot().realizedPnl, 6);
  assert.equal(book.snapshot().equity, 106);
});

test("partial and final close build audit evidence before mutating the ledger", () => {
  const book = new PaperPortfolio({ initialCash: 100 });
  book.open({ pool: "atomic", token: "TOK", price: 2, quantity: 10,
    quantityUnits: "100", notional: 20 });
  const beforePartial = structuredClone(book.serialize());
  assert.throws(() => book.partialClose({ pool: "atomic", quantityUnits: "50",
    price: 3, audit: { invalid: () => true } }), /clone/i);
  assert.deepEqual(book.serialize(), beforePartial);
  const beforeClose = structuredClone(book.serialize());
  assert.throws(() => book.close({ pool: "atomic", price: 3,
    audit: { invalid: () => true } }), /clone/i);
  assert.deepEqual(book.serialize(), beforeClose);
});

test("open builds audit evidence before mutating the ledger", () => {
  const book = new PaperPortfolio({ initialCash: 100 });
  const before = structuredClone(book.serialize());
  assert.throws(() => book.open({ pool: "bad-open", token: "TOK", price: 1,
    quantity: 10, quantityUnits: "10", notional: 10,
    audit: { invalid: () => true } }), /clone/i);
  assert.deepEqual(book.serialize(), before);
});

test("remainder retains a full expected exit gas charge after a partial", () => {
  const book = new PaperPortfolio({ initialCash: 100 });
  book.open({ pool: "gas-remainder", token: "TOK", price: 2, quantity: 10,
    quantityUnits: "100", notional: 20, gasCost: 1 });
  assert.equal(book.snapshot().openPositions[0].expectedExitGasCost, 1);
  book.partialClose({ pool: "gas-remainder", quantityUnits: "50", price: 2,
    proceeds: 10 });
  const remainder = book.snapshot().openPositions[0];
  assert.equal(remainder.entryGasCost, 0.5);
  assert.equal(remainder.expectedExitGasCost, 1);
  assert.ok(Math.abs(remainder.returnPct - (-14.28571428571429)) < 1e-12);
});

test("durable lifecycle state permits exactly one partial close", () => {
  const book = new PaperPortfolio({ initialCash: 100 });
  book.open({ pool: "one-partial", token: "TOK", price: 1, quantity: 10,
    quantityUnits: "100", notional: 10 });
  book.partialClose({ pool: "one-partial", quantityUnits: "50", price: 1 });
  const before = structuredClone(book.serialize());
  assert.throws(() => book.partialClose({ pool: "one-partial", quantityUnits: "25", price: 1 }),
    /partial-already-taken/);
  assert.deepEqual(book.serialize(), before);
});

test("floors policy fractions directly into exact base units", () => {
  assert.equal(floorPartialQuantityUnits("5", 0.5), "2");
  assert.equal(floorPartialQuantityUnits("1000000000000000001", 0.5),
    "500000000000000000");
  assert.throws(() => floorPartialQuantityUnits("1", 0.5),
    /invalid-partial-quantity-units/);
  assert.throws(() => floorPartialQuantityUnits("10", 1), /invalid-close-fraction/);
});

test("large exact-unit positions keep numeric quantity proportional", () => {
  const book = new PaperPortfolio({ initialCash: 100 });
  book.open({ pool: "large-units", token: "TOK", price: 10, quantity: 1,
    quantityUnits: "1000000000000000001", notional: 10 });
  const soldUnits = floorPartialQuantityUnits("1000000000000000001", 0.5);
  book.partialClose({ pool: "large-units", quantityUnits: soldUnits, price: 10,
    proceeds: 5 });
  const remainder = book.snapshot().openPositions[0];
  assert.equal(remainder.quantityUnits, "500000000000000001");
  assert.ok(Math.abs(remainder.quantity - 0.5) < 1e-15);
});

test("partial close refuses missing, zero, or full exact quantities", () => {
  const book = new PaperPortfolio({ initialCash: 100 });
  book.open({ pool: "exact", token: "TOK", price: 1, quantity: 10,
    quantityUnits: "10", notional: 10 });
  assert.throws(() => book.partialClose({ pool: "exact", quantityUnits: "0", price: 1 }),
    /invalid-partial-quantity-units/);
  assert.throws(() => book.partialClose({ pool: "exact", quantityUnits: "10", price: 1 }),
    /invalid-partial-quantity-units/);
  const legacy = new PaperPortfolio({ initialCash: 100 });
  legacy.open({ pool: "legacy", token: "TOK", price: 1, quantity: 10, notional: 10 });
  assert.throws(() => legacy.partialClose({ pool: "legacy", quantityUnits: "5", price: 1 }),
    /partial-exact-units-required/);
});

test("lifecycle telemetry and partial state survive restart without changing decisions", () => {
  const book = new PaperPortfolio({ initialCash: 100 });
  book.open({ pool: "restart", token: "TOK", price: 1, quantity: 10,
    quantityUnits: "100", notional: 10, timestamp: 1,
    entryAdverseBoundaryPct: 20 });
  book.recordLifecycleMark("restart", {
    returnPct: 7, observedPrice: 1.07, timestamp: 13_001,
  });
  book.recordLifecycleMark("restart", {
    returnPct: -2, observedPrice: 0.98, timestamp: 26_001,
  });
  book.partialClose({ pool: "restart", quantityUnits: "50", price: 1.2,
    proceeds: 6, reason: "partial-take-profit", timestamp: 2 });
  const before = book.snapshot().openPositions[0];
  const restored = new PaperPortfolio({ initialCash: 100, state: book.serialize() });
  const after = restored.snapshot().openPositions[0];
  assert.equal(after.partialProfitTaken, true);
  assert.equal(after.maxFavorableExcursionPct, 7);
  assert.equal(after.maxAdverseExcursionPct, -2);
  assert.deepEqual(after.observedPrices, [1.07, 0.98]);
  assert.equal(after.entryAdverseBoundaryPct, 20);
  assert.equal(after.lastLifecycleMarkAt, 26_001);
  assert.equal(after.observedMarkIntervalMs, 13_000);
  assert.deepEqual(after.stopCounterfactuals, {
    8: { breached: false, recoveredToBreakEven: false },
    15: { breached: false, recoveredToBreakEven: false },
    20: { breached: false, recoveredToBreakEven: false },
    30: { breached: false, recoveredToBreakEven: false },
  });
  const decisionInput = (position) => ({ ...position, returnPct: 22,
    peakReturnPct: 22, openedAt: 1 });
  const healthySignal = { state: "healthy", reasons: [] };
  assert.deepEqual(planPaperLifecycleExit(decisionInput(after), 2, undefined, healthySignal),
    planPaperLifecycleExit(decisionInput(before), 2, undefined, healthySignal));
  assert.equal(planPaperLifecycleExit(
    decisionInput(after), 2, undefined, healthySignal,
  ), null);
  const final = restored.close({ pool: "restart", price: 1.1, proceeds: 5.5,
    reason: "adaptive-trailing-stop", timestamp: 3 });
  assert.equal(final.partialProfitTaken, true);
  const afterFinalRestart = new PaperPortfolio({ initialCash: 100,
    state: restored.serialize() });
  assert.equal(afterFinalRestart.snapshot().openPositions.length, 0);
});

test("close records frozen and applied lifecycle boundaries", () => {
  const book = new PaperPortfolio({ initialCash: 100 });
  book.open({ pool: "bounded", token: "TOK", price: 1, quantity: 10,
    notional: 10, entryAdverseBoundaryPct: 20 });
  const trade = book.close({ pool: "bounded", price: 0.8,
    reason: "volatility-risk-boundary", appliedBoundaryPct: 20 });
  assert.equal(trade.entryAdverseBoundaryPct, 20);
  assert.equal(trade.appliedBoundaryPct, 20);
  const second = new PaperPortfolio({ initialCash: 100 });
  second.open({ pool: "no-widen", token: "TOK", price: 1, quantity: 10,
    notional: 10, entryAdverseBoundaryPct: 20 });
  assert.throws(() => second.close({ pool: "no-widen", price: 0.8,
    appliedBoundaryPct: 30 }), /applied-boundary-widens-entry-risk/);
});

test("legacy exact-unit positions can restore, mark, and partially close", () => {
  const first = new PaperPortfolio({ initialCash: 100 });
  first.open({ pool: "legacy-exact", token: "TOK", price: 1, quantity: 10,
    quantityUnits: "100", notional: 10 });
  const legacyState = first.serialize();
  const restored = new PaperPortfolio({ initialCash: 100, state: legacyState });
  restored.mark("legacy-exact", 1.1);
  const partial = restored.partialClose({ pool: "legacy-exact", quantityUnits: "50",
    price: 1.1 });
  assert.equal(partial.remainingQuantityUnits, "50");
});
