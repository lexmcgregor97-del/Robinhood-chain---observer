import test from "node:test";
import assert from "node:assert/strict";
import { auditSwapPrice } from "./price-audit.js";

test("compares token0 quote execution price with spot", () => {
  const result = auditSwapPrice({
    spotPriceQuote: 2.1,
    swap: { absoluteAmount0: "2000000", absoluteAmount1: "1000000000000000000" },
    quoteIsToken0: true,
    token0Decimals: 6,
    token1Decimals: 18,
  });
  assert.equal(result.priceAuditAvailable, true);
  assert.equal(result.lastSwapPriceQuote, 2);
  assert.ok(Math.abs(result.spotVsLastSwapPct - 5) < 1e-12);
});

test("handles token1 as quote without reversing the price", () => {
  const result = auditSwapPrice({
    spotPriceQuote: 4,
    swap: { absoluteAmount0: "500000000000000000", absoluteAmount1: "2000000" },
    quoteIsToken0: false,
    token0Decimals: 18,
    token1Decimals: 6,
  });
  assert.equal(result.lastSwapPriceQuote, 4);
  assert.equal(result.spotVsLastSwapPct, 0);
});

test("fails closed for missing or malformed swap data", () => {
  assert.equal(auditSwapPrice({ spotPriceQuote: 1 }).priceAuditAvailable, false);
  assert.equal(auditSwapPrice({
    spotPriceQuote: 1,
    swap: { absoluteAmount0: "0", absoluteAmount1: "1" },
    quoteIsToken0: true,
    token0Decimals: 18,
    token1Decimals: 18,
  }).priceAuditAvailable, false);
});
