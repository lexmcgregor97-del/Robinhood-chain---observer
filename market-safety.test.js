import test from "node:test";
import assert from "node:assert/strict";
import { decodeV2Reserves, evaluateV2MarketSafety } from "./market-safety.js";

const word = (n) => BigInt(n).toString(16).padStart(64, "0");

test("decodes V2 reserves", () => {
  assert.deepEqual(decodeV2Reserves(`0x${word(1000)}${word(2000)}${word(10)}`),
    { reserve0: 1000n, reserve1: 2000n });
});

test("measures a quote-token V2 round trip", () => {
  const safety = evaluateV2MarketSafety({
    version: "v2", dex: "uniswap", token0: "0xquote", token1: "0xtoken", discoveryBlock: 100,
  }, {
    latestBlock: 200, quoteTokens: ["0xquote"], reserve0: 1_000_000n,
    reserve1: 2_000_000n, quoteAmountIn: 1_000n,
  });
  assert.equal(safety.quoteTokenKnown, true);
  assert.equal(safety.liquidityKnown, true);
  assert.equal(safety.buySimulationOk, true);
  assert.equal(safety.sellSimulationOk, true);
  assert.equal(safety.poolAgeBlocks, 100);
  assert.ok(safety.priceImpactPct >= 0);
  assert.ok(safety.roundTripLossPct >= 0);
});

test("fails closed when neither side is an approved quote token", () => {
  const safety = evaluateV2MarketSafety({
    version: "v2", dex: "uniswap", token0: "0xa", token1: "0xb", discoveryBlock: 1,
  }, {
    latestBlock: 2, quoteTokens: ["0xquote"], reserve0: 100n, reserve1: 100n, quoteAmountIn: 1n,
  });
  assert.equal(safety.quoteTokenKnown, false);
  assert.equal(safety.liquidityKnown, false);
  assert.equal(safety.buySimulationOk, false);
});
