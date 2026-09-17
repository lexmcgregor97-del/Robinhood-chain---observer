import test from "node:test";
import assert from "node:assert/strict";
import {
  cohortComparison, createAsyncReadCache, entryReadyCohorts, recordCohortApproval,
  recordCohortMeasurement, recordCohortRejection, recordFirstMark,
  runIsolatedCohortStage,
} from "./paper-cohort-runtime.js";

const cohort = (strategyVersion) => ({ strategyVersion, automation: {} });

test("ordinary candidate failure cannot suppress the control cohort", async () => {
  const control = cohort("control");
  const candidate = cohort("candidate");
  const called = [];
  const results = await runIsolatedCohortStage([control, candidate], async (item) => {
    called.push(item.strategyVersion);
    if (item === candidate) throw new Error("candidate-rpc-failed");
    return ["measured"];
  }, { stage: "measurement" });
  assert.deepEqual(called, ["control", "candidate"]);
  assert.deepEqual(results.get("control"), { ok: true, value: ["measured"] });
  assert.equal(results.get("candidate").ok, false);
  assert.equal(control.automation.lastError, undefined);
  assert.equal(candidate.automation.lastError, "candidate-rpc-failed");
});

test("global persistence failure aborts later cohort mutations", async () => {
  const control = cohort("control");
  const candidate = cohort("candidate");
  let blocked = false;
  let candidateCalled = false;
  await assert.rejects(runIsolatedCohortStage([control, candidate], async (item) => {
    if (item === control) {
      blocked = true;
      throw new Error("evidence-state-persist-failed");
    }
    candidateCalled = true;
  }, { stage: "entries", globallyBlocked: () => blocked }),
  /evidence-state-persist-failed/);
  assert.equal(candidateCalled, false);
});

test("a cohort with a failed exit stage is excluded from entries", () => {
  const control = cohort("control");
  const candidate = cohort("candidate");
  const exitResults = new Map([
    ["control", { ok: true }],
    ["candidate", { ok: false, error: "exit-rpc-failed" }],
  ]);
  const measurementResults = new Map([
    ["control", { ok: true, value: [] }],
    ["candidate", { ok: true, value: [] }],
  ]);
  assert.deepEqual(
    entryReadyCohorts([control, candidate], exitResults, measurementResults),
    [control],
  );
});

test("one scoped cache shares identical raw reads and retries failures", async () => {
  let calls = 0;
  const read = createAsyncReadCache(async () => {
    calls += 1;
    if (calls === 1) throw new Error("rpc");
    return "ok";
  });
  await assert.rejects(read(10, "eth_call", [{ to: "p" }, "latest"]), /rpc/);
  assert.equal(await read(10, "eth_call", [{ to: "p" }, "latest"]), "ok");
  assert.equal(await read(10, "eth_call", [{ to: "p" }, "latest"]), "ok");
  assert.equal(calls, 2);
  assert.equal(await read(11, "eth_call", [{ to: "p" }, "latest"]), "ok");
  assert.equal(calls, 3);
});

test("durable comparison counters retain attempts, reasons, and overlap", () => {
  const control = {};
  const candidate = {};
  recordCohortMeasurement(control, [{}, {}]);
  recordCohortRejection(control, ["signal-not-ready", "signal-not-ready"]);
  recordCohortApproval(control, "0xA");
  recordCohortApproval(candidate, "0xa");
  recordCohortApproval(candidate, "0xB");
  assert.equal(control.candidatesMeasured, 2);
  assert.equal(control.entryAttempts, 2);
  assert.equal(control.rejectionReasons["signal-not-ready"], 1);
  assert.deepEqual(cohortComparison(control, candidate), {
    controlUniquePools: 1, candidateUniquePools: 2, overlappingUniquePools: 1,
  });
});

test("records one first-mark return and its entry execution cost", () => {
  const automation = {};
  const position = {
    pool: "0xpool", openedAt: 10,
    entryAudit: { executionCostPct: 2.5 },
  };
  recordFirstMark(automation, position, { returnPct: -1.25 }, 20);
  recordFirstMark(automation, position, { returnPct: 4 }, 30);
  assert.deepEqual(automation.firstMarks, [{
    pool: "0xpool", openedAt: 10, markedAt: 20,
    entryReturnPct: -1.25, executionCostPct: 2.5,
  }]);
});
