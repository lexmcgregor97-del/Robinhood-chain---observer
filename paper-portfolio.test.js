import test from "node:test";
import assert from "node:assert/strict";
import { PaperPortfolio } from "./paper-portfolio.js";

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
