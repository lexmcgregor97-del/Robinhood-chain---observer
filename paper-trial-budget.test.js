import test from "node:test";
import assert from "node:assert/strict";
import { PaperTrialBudget } from "./paper-trial-budget.js";
import { RpcTransport } from "./rpc-transport.js";

function make(options = {}) {
  let time = 1000;
  let saved;
  const config = { maxRequests: 3, maxDurationMs: 1000, noProgressMs: 100,
    now: () => time, persist: async (state) => { saved = structuredClone(state); }, ...options };
  const budget = new PaperTrialBudget(config);
  return { budget, config, saved: () => saved, time: (t) => { time = t; } };
}
test("concurrent transport attempts cannot exceed the shared cap", async () => {
  const { budget, saved } = make();
  let sent = 0;
  const transport = new RpcTransport({ urls: ["https://rpc.test"],
    beforeAttempt: () => budget.beforeAttempt(),
    fetchImpl: async () => { sent++; return { ok: true, json: async () => ({ result: 1 }) }; } });
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => transport.request("test", [])));
  assert.equal(sent, 3);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
  assert.equal(saved().requests, 3);
});
test("failover consumes a second physical request and budget denial never fails over", async () => {
  const { budget } = make({ maxRequests: 1 });
  let sent = 0;
  const transport = new RpcTransport({ urls: ["https://a.test", "https://b.test"],
    beforeAttempt: () => budget.beforeAttempt(),
    fetchImpl: async () => { sent++; return { ok: false, status: 429 }; } });
  await assert.rejects(transport.request("test", []), /budget-exhausted/);
  assert.equal(sent, 1);
});
test("reservation survives restart, including an attempt that never reached the network", async () => {
  const h = make({ maxRequests: 1 });
  await h.budget.beforeAttempt();
  const restored = new PaperTrialBudget({ ...h.config, state: h.saved() });
  await assert.rejects(restored.beforeAttempt(), /budget-exhausted/);
});
test("persistence failure blocks the outgoing call", async () => {
  const { budget } = make({ persist: async () => { throw Error("disk full"); } });
  await assert.rejects(budget.beforeAttempt(), /persistence-failed/);
  assert.equal(budget.snapshot().halted, "paper-trial-persistence-failed");
});
test("no-entry timeout halts and survives restart without resetting the clock", async () => {
  const h = make();
  await h.budget.check();
  h.time(1100);
  await assert.rejects(h.budget.check(), /no-entry-progress/);
  const restored = new PaperTrialBudget({ ...h.config, state: h.saved() });
  await assert.rejects(restored.beforeAttempt(), /no-entry-progress/);
});
test("an entry renews progress but cannot extend the absolute time limit", async () => {
  const h = make();
  h.time(1090); await h.budget.progress();
  h.time(1150); await h.budget.check();
  h.time(2000);
  await assert.rejects(h.budget.beforeAttempt(), /time-limit/);
});
test("invalid limits and corrupted checkpoints fail closed", () => {
  assert.throws(() => make({ maxRequests: Infinity }), /invalid/);
  assert.throws(() => make({ state: { requests: -1, startedAt: 1, lastProgressAt: 1 } }), /checkpoint/);
});
