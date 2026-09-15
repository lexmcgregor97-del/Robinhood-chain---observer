import { pathToFileURL } from "node:url";
import { createLiveWorkerRuntime } from "./live-worker-runtime.js";

export async function startLiveWorker({ env = process.env,
  createRuntime = createLiveWorkerRuntime, output = (value) => process.stdout.write(`${value}\n`),
  schedule = setTimeout, cancel = clearTimeout, now = Date.now } = {}) {
  const runtime = await createRuntime({ env, now });
  let stopped = false;
  let timer = null;
  let cycles = 0;
  const report = (payload) => output(JSON.stringify({ service: "atlas-private-live-worker",
    connected: runtime.connected === true, automatic: runtime.automatic === true, ...payload }));
  const cycle = async () => {
    if (stopped) return;
    try {
      const result = await runtime.runOnce({ now: Number(now()) });
      cycles += 1;
      report({ event: "cycle", cycles, status: result.status,
        reason: result.reason || null, intentId: result.intentId || null });
    } catch {
      cycles += 1;
      report({ event: "cycle", cycles, status: "failed", reason: "live-worker-cycle-failed" });
    }
    if (!stopped) timer = schedule(cycle, Number(runtime.config?.pollIntervalMs || 15_000));
  };
  report({ event: "started", status: runtime.connected ? "armed" : "disabled" });
  timer = schedule(cycle, 0);
  return Object.freeze({ runtime, stop() {
    stopped = true;
    if (timer != null) cancel(timer);
    report({ event: "stopped", status: "stopped", cycles });
  } });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const service = await startLiveWorker();
    const stop = () => service.stop();
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  } catch {
    process.stderr.write(`${JSON.stringify({ service: "atlas-private-live-worker",
      status: "startup-failed", reason: "live-worker-startup-failed" })}\n`);
    process.exitCode = 1;
  }
}

