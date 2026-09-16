import { pathToFileURL } from "node:url";
import { liveWorkerConfigFromEnv } from "./live-worker-config.js";

export function verifyDormantLiveWorkerConfig(env = process.env) {
  const config = liveWorkerConfigFromEnv(env);
  const failures = [...config.failures];
  if (config.connected) failures.push("live-worker-verifier-submission-must-remain-disabled");
  if (config.automatic) failures.push("live-worker-verifier-automatic-must-remain-disabled");
  if (!String(env.TURNKEY_SIGNING_API_PRIVATE_KEY || "").trim()) {
    failures.push("live-worker-signing-private-key-required");
  }
  const unique = [...new Set(failures)];
  return Object.freeze({
    verified: config.configured && unique.length === 0,
    mode: config.mode,
    connected: config.connected,
    automatic: config.automatic,
    chainId: config.chainId,
    walletAddress: config.walletAddress || null,
    routerAddress: config.routerAddress || null,
    observerHostname: config.observerHostname || null,
    statePath: config.statePath || null,
    evidencePath: config.evidencePath || null,
    signingCredentialPresent: Boolean(
      String(env.TURNKEY_SIGNING_API_PRIVATE_KEY || "").trim()),
    failures: Object.freeze(unique),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = verifyDormantLiveWorkerConfig();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.verified) process.exitCode = 1;
}
