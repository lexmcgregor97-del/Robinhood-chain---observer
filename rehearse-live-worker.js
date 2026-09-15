import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const TESTS = Object.freeze(["live-worker-e2e.test.js", "live-worker-rehearsal.test.js"]);
const FORBIDDEN = Object.freeze(["TURNKEY_SIGNING_API_PRIVATE_KEY",
  "TURNKEY_SIGNING_VERIFY_API_PRIVATE_KEY", "TURNKEY_ATTESTATION_PRIVATE_KEY"]);

function enabled(value) { return String(value || "").trim().toLowerCase() === "true"; }

export function rehearsalSafetyFailures(env = process.env) {
  const failures = [];
  if (enabled(env.LIVE_WORKER_SUBMISSION_CONNECTED)
      || enabled(env.LIVE_WORKER_AUTOMATIC_SUBMISSION_ENABLED)) {
    failures.push("live-worker-rehearsal-activation-present");
  }
  if (FORBIDDEN.some((key) => String(env[key] || "").trim())) {
    failures.push("live-worker-rehearsal-private-material-present");
  }
  return Object.freeze(failures);
}

function executeTests() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", ...TESTS], {
      cwd: fileURLToPath(new URL(".", import.meta.url)), stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH, NODE_PATH: process.env.NODE_PATH || "" },
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

export async function runDisabledLiveWorkerRehearsal({ env = process.env,
  runTests = executeTests, now = Date.now } = {}) {
  const failures = rehearsalSafetyFailures(env);
  if (failures.length) throw new Error(failures.join(","));
  const result = await runTests();
  if (result?.code !== 0) throw new Error("live-worker-disabled-rehearsal-failed");
  const pass = Number(result.stdout?.match(/(?:#|ℹ)\s*pass\s+(\d+)/)?.[1]);
  const fail = Number(result.stdout?.match(/(?:#|ℹ)\s*fail\s+(\d+)/)?.[1]);
  if (!Number.isSafeInteger(pass) || pass <= 0 || fail !== 0) {
    throw new Error("live-worker-disabled-rehearsal-counts-invalid");
  }
  return Object.freeze({ version: 1, mode: "LOCAL_STUBS_ONLY",
    networkConfigurationWithheld: true,
    signingMaterialLoaded: false, activationFlagsRequiredFalse: true,
    runAt: new Date(Number(now())).toISOString(), tests: TESTS,
    boundaries: Object.freeze(["buy-receipt-before-position-open",
      "position-open-before-allowance-handling", "zero-reset-before-exact-approval",
      "exact-approval-before-exit-send", "sell-receipt-before-position-close"]),
    testCounts: Object.freeze({ pass, fail }),
    result: "pass" });
}

async function main() {
  const report = await runDisabledLiveWorkerRehearsal();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
