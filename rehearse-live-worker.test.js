import test from "node:test";
import assert from "node:assert/strict";
import { rehearsalSafetyFailures, runDisabledLiveWorkerRehearsal }
  from "./rehearse-live-worker.js";

test("disabled rehearsal refuses activation flags and private signing material", () => {
  assert.deepEqual(rehearsalSafetyFailures({ LIVE_WORKER_SUBMISSION_CONNECTED: "true",
    TURNKEY_SIGNING_API_PRIVATE_KEY: "secret" }),
  ["live-worker-rehearsal-activation-present", "live-worker-rehearsal-private-material-present"]);
});

test("disabled rehearsal reports only local stub execution and named restart boundaries", async () => {
  const report = await runDisabledLiveWorkerRehearsal({ env: {}, now: () => 0,
    runTests: async () => ({ code: 0, stdout: "# pass 2\n# fail 0\n" }) });
  assert.equal(report.mode, "LOCAL_STUBS_ONLY");
  assert.equal(report.networkConfigurationWithheld, true);
  assert.equal(report.signingMaterialLoaded, false);
  assert.equal(report.boundaries.length, 5);
  assert.deepEqual(report.testCounts, { pass: 2, fail: 0 });
  assert.equal(report.result, "pass");
});
