import test from "node:test";
import assert from "node:assert/strict";
import {
  findCrossVenueDislocations, PassiveDislocationObserver,
} from "./passive-dislocation-observer.js";

const quote = "0x0000000000000000000000000000000000000001";
const base = "0x0000000000000000000000000000000000000002";
const pool = (address, dex, price, cost = 0.2) => ({
  address, dex, version: "v2", swapCount: 50,
  marketSafety: {
    quoteToken: quote, baseToken: base, tokenPriceQuote: price,
    liquidityKnown: true, buyMathOk: true, sellMathOk: true,
    poolAgeBlocks: 10_000, executionCostPct: cost,
  },
});
const policy = { quoteToken: quote, minimumGrossSpreadPct: 1,
  minimumEstimatedNetEdgePct: 0.25, horizonMs: 100 };

test("counts only conservative cross-venue established-pool dislocations", () => {
  const found = findCrossVenueDislocations([
    pool("0x0000000000000000000000000000000000000011", "pancakeswap", 1),
    pool("0x0000000000000000000000000000000000000012", "uniswap", 1.02),
    { ...pool("0x0000000000000000000000000000000000000013", "other", 2),
      swapCount: 1 },
  ], policy);
  assert.equal(found.length, 1);
  assert.equal(found[0].buyVenue, "pancakeswap");
  assert.ok(found[0].estimatedNetEdgePct > 1.5);
});

test("records convergence without constructing or submitting a transaction", () => {
  const observer = new PassiveDislocationObserver(policy);
  const first = [
    pool("0x0000000000000000000000000000000000000011", "pancakeswap", 1),
    pool("0x0000000000000000000000000000000000000012", "uniswap", 1.02),
  ];
  observer.observe(first, 1_000, { block: 10 });
  observer.observe([
    pool(first[0].address, "pancakeswap", 1.01),
    pool(first[1].address, "uniswap", 1.011),
  ], 1_101, { block: 11 });
  const snapshot = observer.snapshot();
  assert.equal(snapshot.resolvedSamples, 1);
  assert.equal(snapshot.convergenceRatePct, 100);
  assert.equal(snapshot.recentSamples[0].converged, true);
  assert.deepEqual(Object.keys(observer).sort(), ["episodes", "policy", "samples"]);
});

test("restore preserves pending observations", () => {
  const original = new PassiveDislocationObserver(policy);
  original.observe([
    pool("0x0000000000000000000000000000000000000011", "pancakeswap", 1),
    pool("0x0000000000000000000000000000000000000012", "uniswap", 1.02),
  ], 1_000);
  const restored = new PassiveDislocationObserver(policy);
  restored.restore(original.serialize());
  assert.equal(restored.snapshot().openSamples, 1);
  assert.equal(restored.pendingPoolAddresses().length, 2);
});
