import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { loadJsonState, saveJsonState } from "./state-store.js";

function start(stateFile, overrides = {}) {
  const child = fork(new URL("./index.js", import.meta.url), [], {
    execArgv: ["--import", new URL("./test-support/offline-observer.mjs", import.meta.url).href],
    // Deliberately do not inherit credentials, provider URLs, or live settings.
    env: { PATH: process.env.PATH, PORT: "0", STATE_FILE: stateFile,
      RPC_URL: "https://offline.invalid", PAPER_TRIAL_MAX_RPC_REQUESTS: "3",
      RPC_MIN_INTERVAL_MS: "1", RPC_JITTER_MS: "0", POLL_INTERVAL_MS: "10",
      ...overrides },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const run = { child, calls: 0, output: "" };
  child.stdout.on("data", (data) => { run.output += data; });
  child.stderr.on("data", (data) => { run.output += data; });
  run.ready = new Promise((resolve, reject) => {
    child.on("message", (message) => {
      if (message.type === "rpc") run.calls++;
      if (message.type === "ready") resolve(`http://127.0.0.1:${message.port}`);
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(Error(`observer exited ${code}: ${run.output}`)));
  });
  return run;
}
async function stop(run) {
  if (run.child.exitCode !== null || run.child.signalCode !== null) return;
  const exited = once(run.child, "exit");
  run.child.kill("SIGTERM");
  await exited;
}
test("real observer startup caps mocked RPC and restart stays halted with status available", { timeout: 15_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-startup-"));
  const stateFile = join(directory, "state.json");
  const runs = [];
  t.after(async () => { for (const run of runs) await stop(run); await rm(directory, { recursive: true, force: true }); });
  const first = start(stateFile); runs.push(first);
  const url = await first.ready;
  let paper;
  for (let i = 0; i < 100; i++) {
    paper = await (await fetch(`${url}/api/paper`)).json();
    if (paper.trial?.halted) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(paper.trial.halted, "paper-rpc-budget-exhausted");
  assert.equal(paper.newEntriesPaused, true);
  assert.equal(first.calls, 3);
  await stop(first);
  assert.equal((await loadJsonState(`${stateFile}.paper-trial.json`)).requests, 3);
  const second = start(stateFile); runs.push(second);
  const restartedUrl = await second.ready;
  const restored = await (await fetch(`${restartedUrl}/api/paper`)).json();
  assert.equal(restored.trial.halted, "paper-rpc-budget-exhausted");
  assert.equal(restored.trial.requests, 3);
  assert.equal(restored.newEntriesPaused, true);
  assert.equal((await fetch(`${restartedUrl}/health`)).status, 200);
  assert.equal(second.calls, 0);
  await stop(second);
  const third = start(stateFile, { PAPER_TRIAL_ID: "authorized-test" }); runs.push(third);
  const thirdUrl = await third.ready;
  for (let i = 0; i < 100; i++) {
    paper = await (await fetch(`${thirdUrl}/api/paper`)).json();
    if (paper.trial?.halted) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(third.calls, 3);
  assert.equal(paper.trial.halted, "paper-rpc-budget-exhausted");
  await stop(third);
  assert.equal((await loadJsonState(`${stateFile}.paper-trial.json`)).requests, 3);
  const fourth = start(stateFile, { PAPER_TRIAL_ID: "authorized-test" }); runs.push(fourth);
  const fourthUrl = await fourth.ready;
  const fourthPaper = await (await fetch(`${fourthUrl}/api/paper`)).json();
  assert.equal(fourthPaper.trial.halted, "paper-rpc-budget-exhausted");
  assert.equal(fourth.calls, 0);
});

test("restored flat observer catches up and reaches paper evaluation in one scan", { timeout: 15_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-catchup-"));
  const stateFile = join(directory, "state.json");
  // An empty legacy checkpoint is enough to exercise the real restore/poll path.
  await saveJsonState(stateFile, { cursor: 1, pools: [] });
  const run = start(stateFile, { PAPER_TRIAL_MAX_RPC_REQUESTS: "100" });
  t.after(async () => { await stop(run); await rm(directory, { recursive: true, force: true }); });
  const url = await run.ready;
  let health;
  for (let i = 0; i < 200; i++) {
    health = await (await fetch(`${url}/health`)).json();
    if (health.polling.successful > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(health.polling.successful, 1);
  assert.equal(health.cursor, 256);
  assert.equal(health.recovery.skippedBlocks, 0);
  assert.equal(health.recovery.maxBlocksPerPoll, 500);
  assert.equal(health.readiness.readyForPaper, true);
  assert.equal(health.trial.halted, null);
  let paper;
  for (let i = 0; i < 100; i++) {
    paper = await (await fetch(`${url}/api/paper`)).json();
    if (paper.opportunityExperiment.automation.measurementCycles > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(paper.opportunityExperiment.automation.measurementCycles > 0);
  assert.equal(paper.execution.automaticSubmissionEnabled, false);
});

test("real scanner admits a new factory pool after restoring a full dormant registry", { timeout: 15_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-coverage-"));
  const stateFile = join(directory, "state.json");
  const pools = Array.from({ length: 5000 }, (_, i) => ({
    address: `0x${(i + 1).toString(16).padStart(40, "0")}`,
    version: "v2", token0: "old-token", token1: "other-token",
    discoveryTimestampMs: 1, lastSwapTimestampMs: 0, swapCount: 0,
  }));
  await saveJsonState(stateFile, { cursor: 1, pools });
  const run = start(stateFile, { PAPER_TRIAL_MAX_RPC_REQUESTS: "100",
    TEST_DISCOVER_NEW_POOL: "true" });
  t.after(async () => { await stop(run); await rm(directory, { recursive: true, force: true }); });
  const url = await run.ready;
  let health;
  for (let i = 0; i < 200; i++) {
    health = await (await fetch(`${url}/health`)).json();
    if (health.polling.successful > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(health.poolDiscovery.totalPools, 5000);
  assert.equal(health.poolDiscovery.v2Pools, 5000);
  assert.equal(health.poolCoverage.admitted, 1);
  assert.equal(health.poolCoverage.evictedDormant, 1);
  assert.equal(health.poolCoverage.capacityRejected, 0);
  await stop(run);
  const state = await loadJsonState(stateFile);
  assert.ok(state.pools.some((pool) => pool.address === "0x" + "a".repeat(40)));
  assert.equal(state.pools.some((pool) => pool.address === pools[0].address), false);
  assert.equal(state.poolCoverage.evictedDormant, 1);
});
