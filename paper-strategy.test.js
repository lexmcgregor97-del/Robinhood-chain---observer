import test from "node:test";
import assert from "node:assert/strict";
import {
  planPaperEntry, paperExitReason, paperCircuitFailures,
} from "./paper-strategy.js";

const candidate = {
  address: "0xpool",
  riskGate: { eligibleForPaperEntry: true },
  marketSafety: {
    tokenPriceQuote: 2,
    baseToken: "0xtoken",
    baseTokenDecimals: 2,
    buyAmountOut: "4000",
    plannedNotionalQuote: 100,
  },
};

test("sizes paper entries from cash with a hard cap", () => {
  const plan = planPaperEntry(candidate, { cash: 1000, openPositions: [] });
  assert.equal(plan.approved, true);
  assert.equal(plan.order.notional, 100);
  assert.equal(plan.order.quantity, 40);
  assert.equal(plan.order.midPrice, 2);
  assert.equal(plan.order.price, 2.5);
});

test("paper entry fails closed without risk approval or price", () => {
  const plan = planPaperEntry({ ...candidate, riskGate: { eligibleForPaperEntry: false },
    marketSafety: {
      tokenPriceQuote: null, baseTokenDecimals: 2, buyAmountOut: "4000",
    } }, { cash: 1000, openPositions: [] });
  assert.equal(plan.approved, false);
  assert.deepEqual(plan.failures, ["risk-gate-rejected", "price-unavailable"]);
});

test("prevents duplicate pool positions", () => {
  const plan = planPaperEntry(candidate, { cash: 1000, openPositions: [{ pool: "0xpool" }] });
  assert.equal(plan.approved, false);
  assert.ok(plan.failures.includes("position-already-open"));
});

test("blocks new entries at the realized drawdown limit", () => {
  assert.deepEqual(
    paperCircuitFailures({ maxRealizedDrawdownPct: 20 }),
    ["paper-drawdown-circuit-breaker"],
  );
  assert.deepEqual(paperCircuitFailures({ maxRealizedDrawdownPct: 19.99 }), []);
});

test("drawdown circuit fails closed for invalid policy", () => {
  assert.deepEqual(
    paperCircuitFailures({ maxRealizedDrawdownPct: 1 }, { maxRealizedDrawdownPct: 0 }),
    ["invalid-drawdown-policy"],
  );
});

test("applies stop, target, trail and time exits deterministically", () => {
  const now = 1_000_000;
  assert.equal(paperExitReason({ returnPct: -12, openedAt: now }, now), "stop-loss");
  assert.equal(paperExitReason({ returnPct: 50, openedAt: now }, now), "take-profit");
  assert.equal(paperExitReason({ returnPct: 14, peakReturnPct: 25, openedAt: now }, now), "trailing-stop");
  assert.equal(paperExitReason({ returnPct: 1, openedAt: now - 6 * 60 * 60 * 1000 }, now), "max-hold");
  assert.equal(paperExitReason({ returnPct: 5, openedAt: now }, now), null);
});

test("paper entry fails closed without executable AMM output", () => {
  const plan = planPaperEntry({
    ...candidate,
    marketSafety: { tokenPriceQuote: 2, baseToken: "0xtoken" },
  }, { cash: 1000, openPositions: [] });
  assert.equal(plan.approved, false);
  assert.ok(plan.failures.includes("executable-fill-unavailable"));
});

test("paper entry rejects a fill simulated at a different size", () => {
  const plan = planPaperEntry({
    ...candidate,
    marketSafety: { ...candidate.marketSafety, plannedNotionalQuote: 10 },
  }, { cash: 1000, openPositions: [] });
  assert.equal(plan.approved, false);
  assert.ok(plan.failures.includes("fill-size-mismatch"));
});
