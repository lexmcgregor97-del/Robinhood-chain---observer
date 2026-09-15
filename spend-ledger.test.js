import test from "node:test";
import assert from "node:assert/strict";
import { DailySpendLedger } from "./spend-ledger.js";

test("persists spend and rejects replayed intent ids", async () => {
  const now = Date.UTC(2026, 8, 14, 12);
  const ledger = new DailySpendLedger();
  await ledger.record({ intentId: "a", asset: "native", amount: "25" }, now);
  const restored = new DailySpendLedger(ledger.snapshot(now));
  assert.equal(restored.snapshot(now).spent.native, "25");
  await assert.rejects(restored.record(
    { intentId: "a", asset: "native", amount: "25" }, now), /duplicate-intent/);
});

test("rolls limits at the UTC day boundary", async () => {
  const first = Date.UTC(2026, 8, 14, 23, 59);
  const next = Date.UTC(2026, 8, 15, 0, 1);
  const ledger = new DailySpendLedger();
  await ledger.record({ intentId: "a", asset: "native", amount: "25" }, first);
  assert.deepEqual(ledger.snapshot(next).spent, {});
  await ledger.record({ intentId: "a", asset: "native", amount: "5" }, next);
  assert.equal(ledger.snapshot(next).spent.native, "5");
});

test("tracks each spend asset independently", async () => {
  const ledger = new DailySpendLedger();
  await ledger.record({ intentId: "a", asset: "native", amount: "5" });
  await ledger.record({ intentId: "b", asset: "0xabc", amount: "20" });
  assert.deepEqual(ledger.snapshot().spent, { native: "5", "0xabc": "20" });
});

test("rolls back spend state when durable persistence fails", async () => {
  const ledger = new DailySpendLedger({}, {
    persist: async () => { throw new Error("disk-full"); },
  });
  await assert.rejects(ledger.record({ intentId: "a", asset: "native", amount: "5" }),
    /disk-full/);
  assert.deepEqual(ledger.snapshot().spent, {});
  assert.equal(ledger.snapshot().mutationCount, 0);
});

test("serializes concurrent spend checkpoints", async () => {
  const snapshots = [];
  const ledger = new DailySpendLedger({}, { persist: async (state) => {
    await Promise.resolve();
    snapshots.push(state);
  } });
  await Promise.all([
    ledger.record({ intentId: "a", asset: "native", amount: "5" }),
    ledger.record({ intentId: "b", asset: "native", amount: "7" }),
  ]);
  assert.equal(snapshots[0].mutationCount, 1);
  assert.equal(snapshots[0].spent.native, "5");
  assert.equal(snapshots[1].mutationCount, 2);
  assert.equal(snapshots[1].spent.native, "12");
});
