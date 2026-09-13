import test from "node:test";
import assert from "node:assert/strict";
import { rankPools, scorePool } from "./signals.js";

test("flags accelerating activity as escape velocity", () => {
  const signal = scorePool({ lastSwapBlock: 100, recent: [65, 81, 82, 90, 95, 100] }, 100,
    { windowBlocks: 20, minSwaps: 2 });
  assert.equal(signal.state, "escape-velocity");
  assert.equal(signal.swapsCurrentWindow, 5);
  assert.equal(signal.swapsPriorWindow, 1);
  assert.equal(signal.acceleration, 5);
});

test("keeps thin activity quiet", () => {
  const signal = scorePool({ lastSwapBlock: 100, recent: [100] }, 100,
    { windowBlocks: 20, minSwaps: 3 });
  assert.equal(signal.state, "quiet");
});

test("ranks stronger pools first", () => {
  const ranked = rankPools([
    { address: "slow", lastSwapBlock: 100, recent: [82, 99] },
    { address: "fast", lastSwapBlock: 100, recent: [70, 91, 92, 93] },
  ], 100, { windowBlocks: 20, minSwaps: 2 });
  assert.equal(ranked[0].address, "fast");
});
