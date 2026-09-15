import test from "node:test";
import assert from "node:assert/strict";
import { PaperPortfolio } from "./paper-portfolio.js";
import { planPaperEntry, DEFAULT_PAPER_STRATEGY } from "./paper-strategy.js";
import { analyzePaperTrades } from "./paper-analytics.js";
import { assessLiveReadiness } from "./live-readiness.js";
import { evaluateV2MarketSafety } from "./market-safety.js";
import { quoteV2 } from "./v2-simulator.js";
import { ShadowEvaluator } from "./shadow-evaluator.js";
import { PositionLiveness } from "./position-liveness.js";

function humanToUnits(value, decimals) {
  const precision = Math.min(Number(decimals), 12);
  const scaled = Math.floor(Number(value) * (10 ** precision));
  if (!Number.isSafeInteger(scaled) || scaled <= 0) throw new Error("invalid-token-amount");
  return BigInt(scaled) * (10n ** BigInt(Number(decimals) - precision));
}

const pool = { address: "0xpool", version: "v2", dex: "uniswap",
  token0: "0xweth", token1: "0xtok", discoveryBlock: 1 };
const v2 = (reserve0, reserve1, quoteAmountIn = 10n ** 16n) => evaluateV2MarketSafety(pool, {
  latestBlock: 100, quoteAmountIn, quoteTokens: ["0xweth"], reserve0, reserve1,
  token0Decimals: 18, token1Decimals: 18,
});

test("C-1: exit units come from the exact fill, not a Number round trip", () => {
  assert.throws(() => humanToUnits(250_000_000, 18), /invalid-token-amount/);
  const units = (250_000_000n * 10n ** 18n).toString();
  const book = new PaperPortfolio({ initialCash: 0.1 });
  const opened = book.open({ pool: "p", token: "t", price: 4e-11, quantity: 2.5e8,
    quantityUnits: units, notional: 0.01, timestamp: 1 });
  assert.equal(opened.quantityUnits, units);
  const restored = new PaperPortfolio({ initialCash: 0.1, state: book.serialize() });
  assert.equal(restored.serialize().openPositions[0].quantityUnits, units);
  assert.throws(() => book.open({ pool: "q", token: "t", price: 1, quantity: 1,
    quantityUnits: "1.5", notional: 0.01 }), /invalid-quantity-units/);
});

test("C-1: planned entry carries the exact fill units", () => {
  const candidate = { address: "0xpool", riskGate: { eligibleForPaperEntry: true },
    marketSafety: { tokenPriceQuote: 1e-6, baseTokenDecimals: 18,
      buyAmountOut: (10n ** 25n).toString(), plannedNotionalQuote: 0.01, baseToken: "0xtok" } };
  const plan = planPaperEntry(candidate, { cash: 0.1, openPositions: [], trades: [], maxPositions: 3 },
    { ...DEFAULT_PAPER_STRATEGY, entryCashPct: 10, maxEntryNotional: 0.01 });
  assert.equal(plan.approved, true);
  assert.equal(plan.order.quantityUnits, (10n ** 25n).toString());
  assert.equal(plan.order.quantity, 1e7);
});

test("H-1: a measurement-failure close is flagged and blocks live readiness", () => {
  const liveness = new PositionLiveness();
  let reason = null;
  for (let i = 0; i < 20; i += 1) reason = liveness.observe("k", "unavailable");
  assert.equal(reason, "price-unavailable-timeout");
  const book = new PaperPortfolio({ initialCash: 0.1 });
  book.open({ pool: "p", token: "t", price: 1, quantity: 0.01, notional: 0.01, timestamp: 1,
    audit: { strategyVersion: "v" } });
  book.close({ pool: "p", price: 0, proceeds: 0, reason, timestamp: 2, measurementFailure: true });
  const analytics = analyzePaperTrades({ initialCash: 0.1, trades: book.serialize().trades,
    strategyVersion: "v" });
  assert.equal(analytics.measurementFailures, 1);
  assert.equal(analytics.closedTrades, 1);
  const readiness = assessLiveReadiness({ paper: { ...analytics, closedTrades: 50,
    expectancyPerTrade: 1, maxRealizedDrawdownPct: 1 },
  shadow: { uniquePools: 20, eligible: true }, sellProbeReady: true,
  walletConfigured: true, rpcEndpointCount: 2, operationalReady: true });
  assert.ok(readiness.failures.includes("paper-measurement-failures-present"));
});

test("H-2: a drained pool resolves a shadow sample as a total loss, not censored", () => {
  const good = { ...pool, signal: { state: "escape-velocity", swapsCurrentWindow: 10, acceleration: 4 },
    marketSafety: { ...v2(10n ** 19n, 10n ** 24n), priceAuditAvailable: true, spotVsLastSwapPct: 0 } };
  const drained = { ...pool, marketSafety: v2(0n, 10n ** 24n) };
  assert.equal(drained.marketSafety.liquidityZero, true);
  assert.equal(drained.marketSafety.liquidityKnown, false);
  const shadow = new ShadowEvaluator();
  shadow.record([good], 0, { block: 100 });
  assert.equal(shadow.samples[0].entryBlock, 100);
  assert.equal(shadow.samples[0].entryReserves.quote, (10n ** 19n).toString());
  shadow.resolve([drained], 6 * 60_000, { block: 160 });
  const sample = shadow.samples[0];
  assert.equal(sample.censoredAt, undefined);
  assert.equal(sample.netReturnPct, -100);
  assert.equal(sample.exitReason, "liquidity-zero");
  assert.equal(sample.exitBlock, 160);
  const summary = shadow.snapshot().byRule["escape-activity"];
  assert.equal(summary.closedSamples, 1);
  assert.equal(summary.censoredSamples, 0);
});

test("H-2: genuinely unmeasurable prices are still censored", () => {
  const good = { ...pool, signal: { state: "escape-velocity", swapsCurrentWindow: 10, acceleration: 4 },
    marketSafety: { ...v2(10n ** 19n, 10n ** 24n), priceAuditAvailable: true, spotVsLastSwapPct: 0 } };
  const shadow = new ShadowEvaluator();
  shadow.record([good], 0);
  shadow.resolve([{ ...pool, marketSafety: { measurementError: "rpc" } }], 16 * 60_000);
  assert.equal(shadow.samples[0].censorReason, "price-unavailable");
});

test("W-4: V3 zero active liquidity is censored, not booked as a total loss", () => {
  const shadow = new ShadowEvaluator();
  shadow.samples.push({ rule: "escape-activity", ruleVersion: "x", episodeId: "e",
    pool: "0xv3", entryPrice: 1, executionCostPct: 1, openedAt: 0 });
  shadow.resolve([{ address: "0xv3", marketSafety: { activeLiquidityZero: true } }],
    6 * 60_000, { block: 10 });
  assert.equal(shadow.samples[0].censorReason, "active-liquidity-zero");
  assert.equal(shadow.samples[0].netReturnPct, undefined);
});

test("H-3: same-pool re-entry is blocked inside the cooldown window", () => {
  const candidate = { address: "0xpool", riskGate: { eligibleForPaperEntry: true },
    marketSafety: { tokenPriceQuote: 1, baseTokenDecimals: 18,
      buyAmountOut: (10n ** 16n).toString(), plannedNotionalQuote: 0.01, baseToken: "0xtok" } };
  const portfolio = { cash: 0.1, openPositions: [], maxPositions: 3,
    trades: [{ type: "close", pool: "0xpool", timestamp: 1_000_000 }] };
  const policy = { ...DEFAULT_PAPER_STRATEGY, entryCashPct: 10, maxEntryNotional: 0.01 };
  const blocked = planPaperEntry(candidate, portfolio, policy, 1_000_000 + 60_000);
  assert.ok(blocked.failures.includes("pool-reentry-cooldown"));
  const allowed = planPaperEntry(candidate, portfolio, policy, 1_000_000 + 16 * 60_000);
  assert.equal(allowed.approved, true);
});

test("Q1: V2 reserve orientation is consistent for both quote directions", () => {
  const quoteReserve = 10n ** 19n;
  const tokenReserve = 10n ** 24n;
  const quoteIn = 10n ** 16n;
  const a = evaluateV2MarketSafety({ ...pool, token0: "0xweth", token1: "0xtok" }, {
    latestBlock: 1, quoteAmountIn: quoteIn, quoteTokens: ["0xweth"],
    reserve0: quoteReserve, reserve1: tokenReserve, token0Decimals: 18, token1Decimals: 18 });
  const b = evaluateV2MarketSafety({ ...pool, token0: "0xtok", token1: "0xweth" }, {
    latestBlock: 1, quoteAmountIn: quoteIn, quoteTokens: ["0xweth"],
    reserve0: tokenReserve, reserve1: quoteReserve, token0Decimals: 18, token1Decimals: 18 });
  assert.equal(a.buyAmountOut, b.buyAmountOut);
  assert.equal(a.tokenPriceQuote, b.tokenPriceQuote);
  assert.equal(a.roundTripLossPct, b.roundTripLossPct);
  const buy = BigInt(a.buyAmountOut);
  const sell = quoteV2({ reserveIn: tokenReserve - buy, reserveOut: quoteReserve + quoteIn,
    amountIn: buy, feeBps: 30 });
  const expectedLossBps = Number((quoteIn - sell.amountOut) * 10_000n / quoteIn);
  assert.equal(a.roundTripLossPct, expectedLossBps / 100);
});
