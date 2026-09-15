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
    config: { pollIntervalMs: 10 }, runOnce: async () => { throw new Error("provider secret"); } }),
  output: (value) => reports.push(JSON.parse(value)),
  schedule: (fn) => (scheduled.push(fn), scheduled.length), cancel: () => {} });
  await scheduled.shift()();
  assert.equal(reports.at(-1).reason, "live-worker-cycle-failed");
  assert.equal(JSON.stringify(reports).includes("provider secret"), false);
  assert.equal(scheduled.length, 1);
});
