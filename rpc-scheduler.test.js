import test from "node:test";
import assert from "node:assert/strict";
import { nextBackoffMs, RpcScheduler } from "./rpc-scheduler.js";

test("backoff distinguishes rate limits and ordinary errors", () => {
  assert.equal(nextBackoffMs({ currentMs: 5000, rateLimited: true }), 15000);
  assert.equal(nextBackoffMs({ currentMs: 15000, rateLimited: true }), 30000);
  assert.equal(nextBackoffMs({ currentMs: 5000, rateLimited: false }), 10000);
  assert.equal(nextBackoffMs({ currentMs: 120000, rateLimited: true }), 120000);
});

test("serializes concurrent RPC tasks", async () => {
  const scheduler = new RpcScheduler({ minIntervalMs: 0, jitterMs: 0 });
  const order = [];
  const first = scheduler.schedule(async () => {
    order.push("first-start");
    await new Promise((resolve) => setTimeout(resolve, 5));
    order.push("first-end");
  });
  const second = scheduler.schedule(async () => order.push("second"));
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-start", "first-end", "second"]);
  assert.equal(scheduler.snapshot().requestCount, 2);
});

test("records rate limits and applies shared cooldown", async () => {
  const scheduler = new RpcScheduler({ minIntervalMs: 0, jitterMs: 0 });
  await assert.rejects(scheduler.schedule(async () => { throw new Error("RPC HTTP 429"); }));
  const state = scheduler.snapshot();
  assert.equal(state.rateLimitCount, 1);
  assert.ok(state.cooldownMs > 0);
});
