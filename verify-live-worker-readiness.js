import { pathToFileURL } from "node:url";
import { createObserverReadinessAdapter } from "./live-worker-adapters.js";
import { liveWorkerConfigFromEnv } from "./live-worker-config.js";

const PROBE = "observer-endpoint-verification-only";

export function liveWorkerReadinessExitCode(result) {
  return result?.verified === true ? 0 : 1;
}

export async function verifyDormantObserverReadiness(env = process.env,
  { fetchImpl = fetch, now = Date.now() } = {}) {
  const config = liveWorkerConfigFromEnv(env);
  const failures = [...config.failures];
  if (config.connected) failures.push("live-worker-readiness-submission-must-remain-disabled");
  if (config.automatic) failures.push("live-worker-readiness-automatic-must-remain-disabled");
  if (failures.length > 0) return Object.freeze({
    probe: PROBE,
    verified: false,
    endpointAuthenticated: false,
    responseValid: false,
    eligibleForMicroMainnet: false,
    mode: config.mode,
    connected: config.connected,
    automatic: config.automatic,
    observerHostname: config.observerHostname || null,
    failures: Object.freeze([...new Set(failures)]),
  });

  let readiness;
  try {
    readiness = await createObserverReadinessAdapter({
      url: config.observerUrl,
      expectedHostname: config.observerHostname,
      bearerToken: config.observerBearerToken,
      fetchImpl,
    })({ now });
  } catch {
    readiness = Object.freeze({ endpointAuthenticated: false, responseValid: false,
      eligibleForMicroMainnet: false,
      failures: Object.freeze(["observer-live-readiness-adapter-invalid"]) });
  }
  const endpointAuthenticated = readiness.endpointAuthenticated === true;
  return Object.freeze({
    probe: PROBE,
    verified: endpointAuthenticated && readiness.responseValid === true,
    endpointAuthenticated,
    responseValid: readiness.responseValid === true,
    eligibleForMicroMainnet: readiness.eligibleForMicroMainnet,
    mode: config.mode,
    connected: config.connected,
    automatic: config.automatic,
    observerHostname: config.observerHostname,
    failures: readiness.failures,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await verifyDormantObserverReadiness();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = liveWorkerReadinessExitCode(result);
}
