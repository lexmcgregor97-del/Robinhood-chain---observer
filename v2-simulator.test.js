import test from "node:test";
import assert from "node:assert/strict";
import { quoteV2, simulateV2RoundTrip } from "./v2-simulator.js";

test("quotes constant-product output with fee", () => {
  const result = quoteV2({ reserveIn: 1_000_000n, reserveOut: 2_000_000n, amountIn: 10_000n, feeBps: 25 });
  assert.equal(result.amountOut, 19_752n);
  assert.ok(result.priceImpactBps > 0);
});

test("simulates reserve changes across a round trip", () => {
  const result = simulateV2RoundTrip({ reserveQuote: 1_000_000n, reserveToken: 2_000_000n,
    quoteAmountIn: 10_000n, feeBps: 25 });
  assert.ok(result.sellAmountOut < 10_000n);
  assert.ok(result.roundTripLossBps > 0);
  assert.equal(result.profitableWithoutPriceMove, false);
});

test("larger trades incur more impact", () => {
  const small = quoteV2({ reserveIn: 1_000_000n, reserveOut: 1_000_000n, amountIn: 1_000n });
  const large = quoteV2({ reserveIn: 1_000_000n, reserveOut: 1_000_000n, amountIn: 100_000n });
  assert.ok(large.priceImpactBps > small.priceImpactBps);
});

test("rejects invalid reserves and fees", () => {
  assert.throws(() => quoteV2({ reserveIn: 0n, reserveOut: 1n, amountIn: 1n }), /positive/);
  assert.throws(() => quoteV2({ reserveIn: 1n, reserveOut: 1n, amountIn: 1n, feeBps: 10_000 }), /invalid/);
});
