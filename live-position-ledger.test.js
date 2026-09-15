import test from "node:test";
import assert from "node:assert/strict";
import { LivePositionLedger } from "./live-position-ledger.js";

const POOL = "0x0000000000000000000000000000000000000001";
const TOKEN = "0x0000000000000000000000000000000000000002";
const ROUTER = "0x0000000000000000000000000000000000000003";
const entry = { poolAddress: POOL, baseToken: TOKEN, routerAddress: ROUTER,
  baseUnits: "100", entryWethWei: "10", entryIntentId: "buy:1",
  entryTransactionHash: `0x${"1".repeat(64)}` };

test("persists exact units, marks a peak, and closes only its bound exit", async () => {
  const events = [];
  const ledger = new LivePositionLedger({}, { persist: async (_state, event) => events.push(event) });
  await ledger.open(entry, 1);
  await ledger.mark(POOL, "12", 2);
  await ledger.mark(POOL, "11", 3);
  assert.equal(ledger.get(POOL).baseUnits, "100");
  assert.equal(ledger.get(POOL).peakWethOutWei, "12");
  await ledger.requestExit(POOL, { reason: "trailing-stop", intentId: "sell:1" }, 4);
  await assert.rejects(ledger.close(POOL, { intentId: "sell:wrong",
    transactionHash: `0x${"2".repeat(64)}`, wethReceivedWei: "9" }, 5), /close-invalid/);
  await ledger.close(POOL, { intentId: "sell:1",
    transactionHash: `0x${"2".repeat(64)}`, wethReceivedWei: "9" }, 5);
  assert.equal(ledger.openPositions().length, 0);
  assert.equal(ledger.snapshot().history[0].wethReceivedWei, "9");
  assert.deepEqual(events.map((event) => event.type), ["live-position-opened",
    "live-position-marked", "live-position-marked", "live-position-exit-requested",
    "live-position-closed"]);
});

test("rolls memory back when position evidence persistence fails", async () => {
  const ledger = new LivePositionLedger({}, { persist: async () => { throw new Error("disk"); } });
  await assert.rejects(ledger.open(entry), /disk/);
  assert.equal(ledger.openPositions().length, 0);
  assert.equal(ledger.snapshot().mutationCount, 0);
});

test("does not checkpoint immaterial non-peak marks", async () => {
  const events = [];
  const ledger = new LivePositionLedger({}, { persist: async (_state, event) => events.push(event) });
  await ledger.open(entry, 1);
  await ledger.mark(POOL, "9", 2);
  const before = ledger.snapshot().mutationCount;
  const view = await ledger.mark(POOL, "9", 3);
  assert.equal(view.lastMarkedAt, 3);
  assert.equal(ledger.snapshot().mutationCount, before);
  assert.equal(events.filter((event) => event.type === "live-position-marked").length, 1);
});
