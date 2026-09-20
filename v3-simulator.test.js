import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeUint, decodeV3Slot0, normalizedV3Price, quoteV3WithinTick, simulateV3RoundTrip,
} from "./v3-simulator.js";

const word = (n) => BigInt(n).toString(16).padStart(64, "0");

test("decodes slot0 and signed tick", () => {
  const result = `0x${word(1n << 96n)}${word(0xffffff)}`;
  assert.deepEqual(decodeV3Slot0(result), { sqrtPriceX96: 1n << 96n, tick: -1 });
  assert.equal(decodeUint(`0x${word(123)}`, "liquidity"), 123n);
});

test("normalizes either quote orientation", () => {
  const sqrtPriceX96 = 1n << 96n;
  assert.equal(normalizedV3Price({
    sqrtPriceX96, token0Decimals: 18, token1Decimals: 18, quoteIsToken0: false,
  }), 1);
  assert.equal(normalizedV3Price({
    sqrtPriceX96, token0Decimals: 18, token1Decimals: 6, quoteIsToken0: true,
  }), 1e-12);
});

test("simulates a bounded same-tick round trip", () => {
  const result = simulateV3RoundTrip({
    sqrtPriceX96: 1n << 96n,
    liquidity: 1_000_000_000_000_000_000_000n,
    quoteAmountIn: 1_000_000_000_000_000n,
    quoteIsToken0: true,
    feeBps: 30,
  });
  assert.ok(result.buyAmountOut > 0n);
  assert.ok(result.sellAmountOut > 0n);
  assert.ok(result.priceImpactBps >= 0);
  assert.ok(result.sellPriceImpactBps >= 0);
  assert.ok(result.roundTripLossBps >= 0);
});

test("quotes a single executable V3 exit leg", () => {
  const fill = quoteV3WithinTick({
    sqrtPriceX96: 1n << 96n,
    liquidity: 1_000_000_000_000_000_000_000n,
    amountIn: 1_000_000_000_000_000n,
    zeroForOne: false,
    feeBps: 30,
  });
  assert.ok(fill.amountOut > 0n);
  assert.ok(fill.nextSqrtPriceX96 > (1n << 96n));
});
