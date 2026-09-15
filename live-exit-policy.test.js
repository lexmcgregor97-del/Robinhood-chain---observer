import test from "node:test";
import assert from "node:assert/strict";
import { liveExitReason, quoteLivePositionExit } from "./live-exit-policy.js";

const position = { status: "open", entryWethWei: "10000", peakWethOutWei: "11000",
  openedAt: 1, baseUnits: "100", feeBps: 30,
  baseToken: "0x0000000000000000000000000000000000000002" };

test("applies stop, target, trailing, and time exits with integer arithmetic", () => {
  assert.equal(liveExitReason(position, "9200", 2), "stop-loss");
  assert.equal(liveExitReason(position, "13500", 2), "take-profit");
  assert.equal(liveExitReason(position, "10340", 2), "trailing-stop");
  assert.equal(liveExitReason({ ...position, peakWethOutWei: "10000" }, "10000",
    6 * 60 * 60 * 1_000 + 1), "max-hold");
  assert.equal(liveExitReason(position, "10900", 2), null);
});

test("quotes the full exact base-unit position against current reserves", () => {
  const output = quoteLivePositionExit(position, { token0: position.baseToken,
    token1: "0x0000000000000000000000000000000000000001",
    reserve0: "1000", reserve1: "1000" });
  assert.ok(BigInt(output) > 0n);
});
