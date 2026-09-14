import test from "node:test";
import assert from "node:assert/strict";
import {
  bitmapPosition, compressTick, encodeInt16Call, findInitializedTickInWord,
  approximateSqrtRatioAtTick, staysWithinTickBoundary,
} from "./tick-boundary.js";

test("compresses negative ticks with floor semantics", () => {
  assert.equal(compressTick(61, 60), 1);
  assert.equal(compressTick(-1, 60), -1);
  assert.deepEqual(bitmapPosition(-1), { wordPos: -1, bitPos: 255 });
});

test("encodes signed bitmap word positions", () => {
  assert.equal(encodeInt16Call("0x5339c296", 1).length, 74);
  assert.ok(encodeInt16Call("0x5339c296", -1).endsWith("f".repeat(64)));
});

test("finds initialized ticks in either direction", () => {
  const bitmap = (1n << 3n) | (1n << 8n) | (1n << 12n);
  assert.equal(findInitializedTickInWord({
    bitmap, wordPos: 0, currentCompressedTick: 10, tickSpacing: 60, zeroForOne: true,
  }), 8 * 60);
  assert.equal(findInitializedTickInWord({
    bitmap, wordPos: 0, currentCompressedTick: 10, tickSpacing: 60, zeroForOne: false,
  }), 12 * 60);
});

test("applies a conservative boundary buffer", () => {
  const start = approximateSqrtRatioAtTick(0);
  const boundary = approximateSqrtRatioAtTick(-60);
  assert.equal(staysWithinTickBoundary({
    startSqrtPriceX96: start, endSqrtPriceX96: start - 1n,
    boundaryTick: -60, zeroForOne: true,
  }), true);
  assert.equal(staysWithinTickBoundary({
    startSqrtPriceX96: start, endSqrtPriceX96: boundary,
    boundaryTick: -60, zeroForOne: true,
  }), false);
});
