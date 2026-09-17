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

test("floors policy fractions directly into exact base units", () => {
  assert.equal(floorPartialQuantityUnits("5", 0.5), "2");
  assert.equal(floorPartialQuantityUnits("1000000000000000001", 0.5),
    "500000000000000000");
  assert.throws(() => floorPartialQuantityUnits("1", 0.5),
    /invalid-partial-quantity-units/);
  assert.throws(() => floorPartialQuantityUnits("10", 1), /invalid-close-fraction/);
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
    quantityUnits: "100", notional: 10, timestamp: 1 });
  book.recordLifecycleMark("restart", { returnPct: 7, observedPrice: 1.07 });
  book.recordLifecycleMark("restart", { returnPct: -2, observedPrice: 0.98 });
  book.partialClose({ pool: "restart", quantityUnits: "50", price: 1.2,
    proceeds: 6, reason: "partial-take-profit", timestamp: 2 });
  const before = book.snapshot().openPositions[0];
  const restored = new PaperPortfolio({ initialCash: 100, state: book.serialize() });
  const after = restored.snapshot().openPositions[0];
  assert.equal(after.partialProfitTaken, true);
  assert.equal(after.maxFavorableExcursionPct, 7);
  assert.equal(after.maxAdverseExcursionPct, -2);
  assert.deepEqual(after.observedPrices, [1.07, 0.98]);
  const decisionInput = (position) => ({ ...position, returnPct: 22,
    peakReturnPct: 22, openedAt: 1 });
  assert.deepEqual(planPaperLifecycleExit(decisionInput(after), 2),
    planPaperLifecycleExit(decisionInput(before), 2));
  assert.equal(planPaperLifecycleExit(decisionInput(after), 2), null);
});
