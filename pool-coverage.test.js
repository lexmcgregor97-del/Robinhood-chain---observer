import test from "node:test";
import assert from "node:assert/strict";
import { poolAdmission, rankPaperPools } from "./pool-coverage.js";

const now = 10_000_000;
const retentionMs = 61 * 60_000;
const pool = (address, count, overrides = {}) => ({ address, version: "v2",
  token0: "quote", token1: "token", lastSwapTimestampMs: now,
  recentBlocks: [{ timestampMs: now - 1, count }], ...overrides });

test("unsupported leaders cannot crowd executable V2 markets out of the top 25", () => {
  const unsupported = Array.from({ length: 25 }, (_, i) => pool(`v3-${i}`, 100, { version: "v3" }));
  const noQuote = pool("no-quote", 200, { token0: "other" });
  const twoQuotes = pool("two-quotes", 200, { token1: "quote2" });
  const ranked = rankPaperPools([...unsupported, noQuote, twoQuotes, pool("eligible", 6)], now,
    { quoteTokens: new Set(["quote", "quote2"]), limit: 25 });
  assert.deepEqual(ranked.map((p) => p.address), ["eligible"]);
  assert.equal(ranked[0].signal.swapsCurrentWindow, 6);
});

test("supported universe still obeys measurement limit and excludes inactive pools", () => {
  const ranked = rankPaperPools([pool("quiet", 0), pool("thin", 1), pool("busy", 6)], now,
    { quoteTokens: new Set(["quote"]), limit: 1 });
  assert.deepEqual(ranked.map((p) => p.address), ["busy"]);
});

test("full registry replaces oldest dormant pool, preserving recent flow history", () => {
  const pools = new Map([
    ["old", pool("old", 0, { lastSwapTimestampMs: 1 })],
    ["recent", pool("recent", 1, { lastSwapTimestampMs: now - retentionMs + 1 })],
  ]);
  const result = poolAdmission(pools, { address: "new" }, { capacity: 2, nowMs: now, retentionMs });
  assert.deepEqual(result, { admitted: true, evict: "old" });
  assert.equal(pools.size, 2); // Decision itself never mutates the checkpoint.
});

test("open positions, pending samples and current-range activity pin dormant pools", () => {
  const pools = new Map(["position", "sample", "revived", "idle"].map((address, i) =>
    [address, pool(address, 0, { lastSwapTimestampMs: i + 1 })]));
  const result = poolAdmission(pools, { address: "new" }, {
    capacity: 4, nowMs: now, retentionMs,
    protectedAddresses: new Set(["position", "sample", "revived"]),
  });
  assert.deepEqual(result, { admitted: true, evict: "idle" });
});

test("new pools keep their warmup and saturated protected registries reject explicitly", () => {
  const pools = new Map([["new", pool("new", 0, {
    lastSwapTimestampMs: 0, discoveryTimestampMs: now - 1,
  })]]);
  assert.deepEqual(poolAdmission(pools, { address: "incoming" }, {
    capacity: 1, nowMs: now, retentionMs,
  }), { admitted: false, reason: "capacity-protected" });
  assert.deepEqual(poolAdmission(pools, { address: "new" }, {
    capacity: 1, nowMs: now, retentionMs,
  }), { admitted: false, reason: "already-known" });
});

test("invalid clock cannot evict and available capacity needs no eviction", () => {
  const pools = new Map([["old", pool("old", 0, { lastSwapTimestampMs: 1 })]]);
  assert.equal(poolAdmission(pools, { address: "new" }, {
    capacity: 1, nowMs: NaN, retentionMs,
  }).admitted, false);
  assert.deepEqual(poolAdmission(pools, { address: "new" }, {
    capacity: 2, nowMs: now, retentionMs,
  }), { admitted: true, evict: null });
});
