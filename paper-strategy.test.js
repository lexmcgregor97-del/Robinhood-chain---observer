import test from "node:test";
import assert from "node:assert/strict";
import { planPaperEntry, paperExitReason } from "./paper-strategy.js";

const candidate = {
  address: "0xpool",
  riskGate: { eligibleForPaperEntry: true },
  marketSafety: { tokenPriceQuote: 2, baseToken: "0xtoken" },
};

test("sizes paper entries from cash with a hard cap", () => {
  const plan = planPaperEntry(candidate, { cash: 1000, openPositions: [] });
  assert.equal(plan.approved, true);
  assert.equal(plan.order.notional, 100);
  assert.equal(plan.order.price, 2);
});

test("paper entry fails closed without risk approval or price", () => {
  const plan = planPaperEntry({ ...candidate, riskGate: { eligibleForPaperEntry: false },
    marketSafety: { tokenPriceQuote: null } }, { cash: 1000, openPositions: [] });
  assert.equal(plan.approved, false);
  assert.deepEqual(plan.failures, ["risk-gate-rejected", "price-unavailable"]);
});

test("prevents duplicate pool positions", () => {
  const plan = planPaperEntry(candidate, { cash: 1000, openPositions: [{ pool: "0xpool" }] });
  assert.equal(plan.approved, false);
  assert.ok(plan.failures.includes("position-already-open"));
});

test("applies stop, target, trail and time exits deterministically", () => {
  const now = 1_000_000;
  assert.equal(paperExitReason({ returnPct: -12, openedAt: now }, now), "stop-loss");
  assert.equal(paperExitReason({ returnPct: 50, openedAt: now }, now), "take-profit");
  assert.equal(paperExitReason({ returnPct: 14, peakReturnPct: 25, openedAt: now }, now), "trailing-stop");
  assert.equal(paperExitReason({ returnPct: 1, openedAt: now - 6 * 60 * 60 * 1000 }, now), "max-hold");
  assert.equal(paperExitReason({ returnPct: 5, openedAt: now }, now), null);
});
