import test from "node:test";
import assert from "node:assert/strict";
import { startLiveWorker } from "./run-live-worker.js";

test("disabled Railway worker stays inert and reports no configuration values", async () => {
  const reports = [];
  const scheduled = [];
  const service = await startLiveWorker({
    createRuntime: async () => ({ connected: false, automatic: false,
      config: { pollIntervalMs: 10, secret: "never-print" },
      runOnce: async () => ({ status: "disabled", reason: "live-worker-not-armed" }) }),
    output: (value) => reports.push(JSON.parse(value)),
    schedule: (fn) => (scheduled.push(fn), scheduled.length), cancel: () => {} });
  assert.equal(reports[0].status, "disabled");
  assert.equal(JSON.stringify(reports).includes("never-print"), false);
  await scheduled.shift()();
  assert.equal(reports[1].status, "disabled");
  service.stop();
});

test("cycle exceptions are redacted and the worker remains scheduled", async () => {
  const reports = [];
  const scheduled = [];
  await startLiveWorker({ createRuntime: async () => ({ connected: true, automatic: true,
    config: { pollIntervalMs: 10, failureBackoffMaxMs: 100, failureStopThreshold: 10 },
    runOnce: async () => { throw new Error("provider secret"); } }),
  output: (value) => reports.push(JSON.parse(value)),
  schedule: (fn) => (scheduled.push(fn), scheduled.length), cancel: () => {} });
  await scheduled.shift()();
  assert.equal(reports.at(-1).reason, "cycle-exception");
  assert.equal(JSON.stringify(reports).includes("provider secret"), false);
  assert.equal(scheduled.length, 1);
});

test("persistent failures halt at the configured ceiling", async () => {
  const reports = [];
  const scheduled = [];
  await startLiveWorker({ createRuntime: async () => ({ connected: true, automatic: true,
    config: { pollIntervalMs: 10, failureBackoffMaxMs: 100, failureStopThreshold: 2 },
    runOnce: async () => { throw new Error("down"); } }),
  output: (value) => reports.push(JSON.parse(value)),
  schedule: (fn, delay) => (scheduled.push({ fn, delay }), scheduled.length), cancel: () => {} });
  const first = scheduled.shift();
  await first.fn();
  assert.equal(scheduled[0].delay, 10);
  const second = scheduled.shift();
  await second.fn();
  assert.equal(reports.at(-1).status, "halted");
  assert.equal(scheduled.length, 0);
});
