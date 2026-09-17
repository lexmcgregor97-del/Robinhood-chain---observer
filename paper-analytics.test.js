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

test("isolates a frozen paper strategy epoch from legacy trades", () => {
  const trades = [
    { type: "open", pool: "legacy", notional: 10, fee: 0.1, timestamp: 1 },
    { type: "close", pool: "legacy", pnl: 10, fee: 0.1, timestamp: 2 },
    { type: "open", pool: "current", notional: 10, fee: 0.2, timestamp: 3,
      audit: { strategyVersion: "paper-v2" } },
    { type: "close", pool: "current", pnl: -2, fee: 0.3, timestamp: 4 },
  ];
  const result = analyzePaperTrades({ initialCash: 100, trades, strategyVersion: "paper-v2" });
  assert.equal(result.closedTrades, 1);
  assert.equal(result.realizedPnl, -2);
  assert.equal(result.feesPaid, 0.5);
  assert.equal(result.maxRealizedDrawdownPct, 2);
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

test("reports mark-to-market drawdown and gas separately", () => {
  const result = analyzePaperTrades({
    initialCash: 1,
    trades: [
      { type: "open", pool: "a", notional: 0.1, gasCost: 0.01,
        timestamp: 1, audit: { strategyVersion: "v" } },
    ],
    openPositions: [{ pool: "a", unrealizedPnl: -0.05 }],
    strategyVersion: "v",
  });
  assert.equal(result.openTrades, 1);
  assert.ok(Math.abs(result.markToMarketDrawdownPct - 5) < 1e-12);
  assert.equal(result.maxRealizedDrawdownPct, 0);
});

test("retains the running maximum marked drawdown after an open position recovers", () => {
  const trades = [{ type: "open", pool: "a", notional: 10, timestamp: 1,
    audit: { strategyVersion: "v" } }];
  const deep = analyzePaperTrades({ initialCash: 100, trades, strategyVersion: "v",
    openPositions: [{ unrealizedPnl: -5 }] });
  const recovered = analyzePaperTrades({ initialCash: 100, trades, strategyVersion: "v",
    openPositions: [{ unrealizedPnl: 0 }],
    priorMaxMarkedDrawdownPct: deep.maxMarkedDrawdownPct });
  assert.equal(deep.currentMarkedDrawdownPct, 5);
  assert.equal(recovered.currentMarkedDrawdownPct, 0);
  assert.equal(recovered.maxMarkedDrawdownPct, 5);
});

test("counts a partial and final close as one lifecycle trade", () => {
  const result = analyzePaperTrades({
    initialCash: 100,
    trades: [
      { type: "open", pool: "p", token: "TOK", notional: 20, gasCost: 1,
        fee: 0.1, timestamp: 1, audit: { strategyVersion: "lifecycle" } },
      { type: "partial-close", pool: "p", pnl: 4, allocatedCostBasis: 10.5,
        gasCost: 0.2, fee: 0.1, timestamp: 2, reason: "partial-take-profit" },
      { type: "close", pool: "p", pnl: -1, gasCost: 0.3, fee: 0.1,
        timestamp: 3, reason: "adaptive-trailing-stop", partialProfitTaken: true,
        maxFavorableExcursionPct: 25, maxAdverseExcursionPct: -3 },
    ],
    strategyVersion: "lifecycle",
  });
  assert.equal(result.closedTrades, 1);
  assert.equal(result.realizedPnl, 3);
  assert.equal(result.expectancyPerTrade, 3);
  assert.equal(result.partialCloses, 1);
  assert.equal(result.positionsWithPartial, 1);
  assert.equal(result.partialRealizedPnl, 4);
  assert.equal(result.remainderPnlAfterPartial, -1);
  assert.equal(result.byPartialExitReason["partial-take-profit"].trades, 1);
  assert.equal(result.byExitReason["adaptive-trailing-stop"].pnl, 3);
  assert.equal(result.gasPaid, 1.5);
  assert.ok(Math.abs(result.feesPaid - 0.3) < 1e-12);
  assert.equal(result.averageMaxFavorableExcursionPct, 25);
  assert.equal(result.averageMaxAdverseExcursionPct, -3);
});

test("reports orphaned partial records instead of silently dropping them", () => {
  const result = analyzePaperTrades({ initialCash: 100, trades: [
    { type: "partial-close", pool: "missing", pnl: 4, fee: 0.1 },
  ] });
  assert.equal(result.partialCloses, 0);
  assert.equal(result.orphanedPartialCloses, 1);
  assert.equal(result.realizedPnl, 0);
});
