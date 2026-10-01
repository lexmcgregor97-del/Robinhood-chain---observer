import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { loadJsonState } from "./state-store.js";

function start(stateFile) {
  const child = fork(new URL("./index.js", import.meta.url), [], {
    execArgv: ["--import", new URL("./test-support/offline-observer.mjs", import.meta.url).href],
    // Deliberately do not inherit credentials, provider URLs, or live settings.
    env: { PATH: process.env.PATH, PORT: "0", STATE_FILE: stateFile,
      RPC_URL: "https://offline.invalid", PAPER_TRIAL_MAX_RPC_REQUESTS: "3",
      RPC_MIN_INTERVAL_MS: "1", RPC_JITTER_MS: "0", POLL_INTERVAL_MS: "10" },
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
});
