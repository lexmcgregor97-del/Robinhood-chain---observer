import test from "node:test";
import assert from "node:assert/strict";
import { rankPools, scorePool } from "./signals.js";

const minute = 60_000;
const bucket = (minutesAgo, count) => ({
  blockNumber: 1_000 - minutesAgo,
  timestampMs: (10 - minutesAgo) * minute,
  count,
});

test("flags accelerating wall-clock activity as escape velocity", () => {
  const signal = scorePool({
    lastSwapTimestampMs: 10 * minute,
    recentBlocks: [bucket(5, 5), bucket(4, 5), bucket(0, 10)],
  }, 10 * minute, { windowMs: minute, baselineMs: 5 * minute, minSwaps: 3 });
  assert.equal(signal.state, "escape-velocity");
  assert.equal(signal.swapsCurrentWindow, 10);
  assert.equal(signal.swapsBaselineWindow, 10);
  assert.equal(signal.baselineEquivalent, 2);
  assert.equal(signal.acceleration, 5);
});

test("keeps thin activity quiet", () => {
  const signal = scorePool({
    lastSwapTimestampMs: 10 * minute,
    recentBlocks: [bucket(0, 1)],
  }, 10 * minute, { windowMs: minute, baselineMs: 5 * minute, minSwaps: 3 });
  assert.equal(signal.state, "quiet");
});

test("stationary rates do not fabricate acceleration when busy", () => {
  const recentBlocks = [];
  for (let secondsAgo = 0.5; secondsAgo < 360; secondsAgo += 1) {
    recentBlocks.push({
      blockNumber: 10_000 - Math.floor(secondsAgo),
      timestampMs: 10 * minute - secondsAgo * 1_000,
      count: 3,
    });
  }
  const signal = scorePool({ lastSwapTimestampMs: 10 * minute, recentBlocks },
    10 * minute, { windowMs: minute, baselineMs: 5 * minute, minSwaps: 3 });
  assert.equal(signal.swapsCurrentWindow, 180);
  assert.equal(signal.swapsBaselineWindow, 900);
  assert.equal(signal.acceleration, 1);
  assert.equal(signal.state, "active");
});

test("ranks stronger pools first", () => {
  const ranked = rankPools([
    { address: "slow", lastSwapTimestampMs: 10 * minute, recentBlocks: [bucket(0, 2)] },
    { address: "fast", lastSwapTimestampMs: 10 * minute, recentBlocks: [bucket(3, 2), bucket(0, 6)] },
  ], 10 * minute, { windowMs: minute, baselineMs: 5 * minute, minSwaps: 2 });
  assert.equal(ranked[0].address, "fast");
});
