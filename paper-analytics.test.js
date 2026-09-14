import test from "node:test";
import assert from "node:assert/strict";
import { analyzePaperTrades } from "./paper-analytics.js";

const trades = [
  { type: "open", pool: "a", token: "A", notional: 10, fee: 0.1, timestamp: 100,
    audit: { signal: "escape-velocity", version: "v3", venue: "uniswap" } },
  { type: "close", pool: "a", token: "A", pnl: 5, fee: 0.1, timestamp: 200,
    reason: "take-profit" },
  { type: "open", pool: "b", token: "B", notional: 20, fee: 0.2, timestamp: 300,
    audit: { signal: "breakout-watch", version: "v2", venue: "pancakeswap" } },
  { type: "close", pool: "b", token: "B", pnl: -10, fee: 0.2, timestamp: 500,
    reason: "stop-loss" },
];

test("computes fee-adjusted paper performance", () => {
  const result = analyzePaperTrades({ initialCash: 100, trades });
  assert.equal(result.closedTrades, 2);
  assert.equal(result.wins, 1);
  assert.equal(result.losses, 1);
  assert.equal(result.winRatePct, 50);
  assert.equal(result.realizedPnl, -5);
  assert.equal(result.expectancyPerTrade, -2.5);
  assert.equal(result.averageWin, 5);
  assert.equal(result.averageLoss, -10);
  assert.equal(result.averageHoldMs, 150);
  assert.ok(Math.abs(result.feesPaid - 0.6) < 1e-12);
  assert.equal(result.maxRealizedDrawdownPct, (10 / 105) * 100);
});

test("groups outcomes by entry and exit context", () => {
  const result = analyzePaperTrades({ initialCash: 100, trades });
  assert.equal(result.bySignal["escape-velocity"].pnl, 5);
  assert.equal(result.byVersion.v2.pnl, -10);
  assert.equal(result.byVenue.pancakeswap.trades, 1);
  assert.equal(result.byExitReason["stop-loss"].losses, 1);
});

test("ignores unmatched closes and counts open trades", () => {
  const result = analyzePaperTrades({
    initialCash: 10,
    trades: [
      { type: "close", pool: "missing", pnl: 5, fee: 1 },
      { type: "open", pool: "open", notional: 1, fee: 0.01 },
    ],
  });
  assert.equal(result.closedTrades, 0);
  assert.equal(result.openTrades, 1);
  assert.equal(result.feesPaid, 1.01);
});
