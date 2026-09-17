import test from "node:test";
import assert from "node:assert/strict";
import { adaptiveFlowSignal, quoteFlowFromSwap } from "./adaptive-flow.js";

const minute = 60_000;

test("orients quote inflow as a base-token buy", () => {
  const flow = quoteFlowFromSwap({ token0: "0xbase", token1: "0xquote" }, {
    amount0: "-2000000000000000000", amount1: "1500000",
  }, [{ address: "0xquote", symbol: "USDG", decimals: 6 }]);
  assert.deepEqual(flow, {
    quoteAmount: 1.5, side: "buy", quoteToken: "0xquote", quoteSymbol: "USDG",
  });
});

test("uses a sparse zero-inclusive trimmed hourly baseline", () => {
  const now = 100 * minute;
  const flows = [];
  for (let index = 2; index <= 21; index += 1) {
    flows.push({ timestampMs: now - index * minute + 1_000, quoteAmount: 10, side: "buy" });
  }
  flows.push({ timestampMs: now, quoteAmount: 20, side: "buy" });
  flows.push({ timestampMs: now, quoteAmount: 10, side: "sell" });
  const result = adaptiveFlowSignal(flows, now + 1_000);
  assert.equal(result.ready, true);
  assert.equal(result.activeBaselineMinutes, 20);
  assert.equal(result.baselineQuoteVolumePerMinute, 10);
  assert.equal(result.volumeMultiple, 3);
  assert.equal(result.buyShare, 2 / 3);
});

test("orients token0 quote flow and rejects ambiguous quote pools", () => {
  const quotes = [{ address: "0xquote", symbol: "USDG", decimals: 6 }];
  assert.equal(quoteFlowFromSwap({ token0: "0xquote", token1: "0xbase" }, {
    amount0: "1500000", amount1: "-2000000000000000000",
  }, quotes).side, "buy");
  assert.equal(quoteFlowFromSwap({ token0: "0xquote", token1: "0xbase" }, {
    amount0: "-1500000", amount1: "2000000000000000000",
  }, quotes).side, "sell");
  assert.equal(quoteFlowFromSwap({ token0: "0xbase", token1: "0xother" }, {
    amount0: "1", amount1: "-1",
  }, quotes), null);
  assert.equal(quoteFlowFromSwap({ token0: "0xquote", token1: "0xquote" }, {
    amount0: "1", amount1: "-1",
  }, quotes), null);
});

test("aligns the current window to the latest wall-clock minute", () => {
  const minuteStart = 100 * minute;
  const flows = [];
  for (let index = 1; index <= 20; index += 1) {
    flows.push({ timestampMs: minuteStart - index * minute, quoteAmount: 10, side: "buy" });
  }
  flows.push({ timestampMs: minuteStart, quoteAmount: 40, side: "buy" });
  const early = adaptiveFlowSignal(flows, minuteStart + 1_000);
  const late = adaptiveFlowSignal(flows, minuteStart + 59_000);
  assert.equal(early.currentQuoteVolume, 40);
  assert.equal(late.currentQuoteVolume, 40);
  assert.equal(early.volumeMultiple, late.volumeMultiple);
});

test("trims one extreme active-minute outlier", () => {
  const now = 100 * minute;
  const flows = [];
  for (let index = 2; index <= 20; index += 1) {
    flows.push({ timestampMs: now - index * minute, quoteAmount: 10, side: "buy" });
  }
  flows.push({ timestampMs: now - 21 * minute, quoteAmount: 10_000, side: "buy" });
  flows.push({ timestampMs: now, quoteAmount: 20, side: "buy" });
  const result = adaptiveFlowSignal(flows, now + 1_000);
  assert.equal(result.baselineQuoteVolumePerMinute, 10);
  assert.equal(result.volumeMultiple, 2);
});

test("ignores malformed and non-positive flow records", () => {
  const now = 100 * minute;
  const result = adaptiveFlowSignal([
    { timestampMs: now, buyQuoteVolume: "abc", sellQuoteVolume: null },
    { timestampMs: now, quoteAmount: -10, side: "buy" },
  ], now + 1_000);
  assert.equal(result.currentQuoteVolume, 0);
  assert.equal(result.ready, false);
});

test("refuses a flow multiple before enough baseline minutes exist", () => {
  const now = 100 * minute;
  const result = adaptiveFlowSignal([
    { timestampMs: now - 2 * minute, quoteAmount: 10, side: "buy" },
    { timestampMs: now - 1_000, quoteAmount: 30, side: "buy" },
  ], now);
  assert.equal(result.ready, false);
  assert.equal(result.volumeMultiple, null);
});

test("accepts minute-compressed buy and sell flow buckets", () => {
  const now = 100 * minute;
  const flows = [];
  for (let index = 2; index <= 21; index += 1) {
    flows.push({
      timestampMs: now - index * minute,
      buyQuoteVolume: 6,
      sellQuoteVolume: 4,
      buys: 2,
      sells: 1,
    });
  }
  flows.push({
    timestampMs: now,
    buyQuoteVolume: 20,
    sellQuoteVolume: 10,
    buys: 4,
    sells: 2,
  });
  const result = adaptiveFlowSignal(flows, now + 1_000);
  assert.equal(result.currentQuoteVolume, 30);
  assert.equal(result.buyShare, 2 / 3);
  assert.equal(result.buys, 4);
  assert.equal(result.sells, 2);
});
