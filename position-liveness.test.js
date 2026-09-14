import test from "node:test";
import assert from "node:assert/strict";
import { PositionLiveness } from "./position-liveness.js";

test("confirms measured zero liquidity over consecutive cycles", () => {
  const tracker = new PositionLiveness({ zeroLiquidityCycles: 3 });
  assert.equal(tracker.observe("book:pool", "zero-liquidity"), null);
  assert.equal(tracker.observe("book:pool", "zero-liquidity"), null);
  assert.equal(tracker.observe("book:pool", "zero-liquidity"), "liquidity-zero");
});

test("uses a longer bound for unavailable measurements and resets on health", () => {
  const tracker = new PositionLiveness({ unavailableCycles: 3 });
  tracker.observe("book:pool", "unavailable");
  tracker.observe("book:pool", "healthy");
  assert.equal(tracker.observe("book:pool", "unavailable"), null);
  assert.equal(tracker.observe("book:pool", "unavailable"), null);
  assert.equal(tracker.observe("book:pool", "unavailable"), "price-unavailable-timeout");
});

test("round-trips unresolved liveness state", () => {
  const first = new PositionLiveness();
  first.observe("book:pool", "unavailable");
  const restored = new PositionLiveness({ state: first.serialize() });
  assert.deepEqual(restored.serialize(), first.serialize());
});
