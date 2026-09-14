import test from "node:test";
import assert from "node:assert/strict";
import { DailySpendLedger } from "./spend-ledger.js";

test("persists spend and rejects replayed intent ids", () => {
  const now = Date.UTC(2026, 8, 14, 12);
  const ledger = new DailySpendLedger();
  ledger.record({ intentId: "a", asset: "native", amount: "25" }, now);
  const restored = new DailySpendLedger(ledger.snapshot(now));
  assert.equal(restored.snapshot(now).spent.native, "25");
  assert.throws(() => restored.record({ intentId: "a", asset: "native", amount: "25" }, now), /duplicate-intent/);
});

test("rolls limits at the UTC day boundary", () => {
  const first = Date.UTC(2026, 8, 14, 23, 59);
  const next = Date.UTC(2026, 8, 15, 0, 1);
  const ledger = new DailySpendLedger();
  ledger.record({ intentId: "a", asset: "native", amount: "25" }, first);
  assert.deepEqual(ledger.snapshot(next).spent, {});
  ledger.record({ intentId: "a", asset: "native", amount: "5" }, next);
  assert.equal(ledger.snapshot(next).spent.native, "5");
});

test("tracks each spend asset independently", () => {
  const ledger = new DailySpendLedger();
  ledger.record({ intentId: "a", asset: "native", amount: "5" });
  ledger.record({ intentId: "b", asset: "0xabc", amount: "20" });
  assert.deepEqual(ledger.snapshot().spent, { native: "5", "0xabc": "20" });
});
