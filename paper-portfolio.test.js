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
