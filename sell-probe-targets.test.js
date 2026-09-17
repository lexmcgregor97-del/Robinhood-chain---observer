import test from "node:test";
import assert from "node:assert/strict";
import { selectSellProbeTargets } from "./sell-probe-targets.js";

function candidate(address, overrides = {}) {
  return {
    address,
    version: "v2",
    marketSafety: { buyMathOk: true, sellMathOk: true },
    lastSellSwap: { transactionHash: `0x${address}` },
    ...overrides,
  };
}

const callbacks = (options = {}) => ({
  observedSellFor: (item) => item.lastSellSwap,
  hasFreshProbe: (item) => options.fresh?.has(item.address) === true,
  isPaperEntryEligible: (item) => options.ineligible?.has(item.address) !== true,
});

test("selects the highest-ranked unprobed paper-eligible candidates", () => {
  const targets = selectSellProbeTargets([
    candidate("a"), candidate("b"), candidate("c"), candidate("d"),
  ], { ...callbacks(), limit: 3 });
  assert.deepEqual(targets.map(({ candidate: item }) => item.address), ["a", "b", "c"]);
});

test("skips a fresh top probe and pools blocked from another paper entry", () => {
  const targets = selectSellProbeTargets([
    candidate("maxed"), candidate("fresh"), candidate("next"),
  ], callbacks({ fresh: new Set(["fresh"]), ineligible: new Set(["maxed"]) }));
  assert.deepEqual(targets.map(({ candidate: item }) => item.address), ["next"]);
});

test("rejects candidates that cannot support the exact V2 sell probe", () => {
  const targets = selectSellProbeTargets([
    candidate("v3", { version: "v3" }),
    candidate("bad-buy", { marketSafety: { buyMathOk: false, sellMathOk: true } }),
    candidate("bad-sell", { marketSafety: { buyMathOk: true, sellMathOk: false } }),
    candidate("no-swap", { lastSellSwap: null }),
    candidate("valid"),
  ], callbacks());
  assert.deepEqual(targets.map(({ candidate: item }) => item.address), ["valid"]);
});
