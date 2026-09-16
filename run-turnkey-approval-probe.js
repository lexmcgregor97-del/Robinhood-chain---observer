import { pathToFileURL } from "node:url";
import { Turnkey } from "@turnkey/sdk-server";
import { microMainnetConfigFromEnv } from "./micro-mainnet-config.js";
import {
  buildTurnkeyBehavioralCases, submitActivity,
} from "./run-turnkey-behavioral-matrix.js";
import { verifyTurnkeyAllowedActivity } from "./turnkey-activity-matrix.js";
import { probeTurnkeySigningPolicy } from "./turnkey-signing-probe.js";

const CONFIRMATION = "RUN_ATLAS_TURNKEY_APPROVAL_PROBE_NO_BROADCAST";

export async function runTurnkeyApprovalProbe(env = process.env, {
  makeClient,
  verifyPolicy = probeTurnkeySigningPolicy,
  verifyActivity = verifyTurnkeyAllowedActivity,
} = {}) {
  if (env.TURNKEY_APPROVAL_PROBE_CONFIRMATION !== CONFIRMATION) {
    throw new Error("turnkey-approval-probe-confirmation-required");
  }
  if (String(env.LIVE_WORKER_SUBMISSION_CONNECTED || "").toLowerCase() === "true"
      || String(env.LIVE_WORKER_AUTOMATIC_SUBMISSION_ENABLED || "").toLowerCase() === "true") {
    throw new Error("turnkey-approval-probe-live-flags-forbidden");
  }
  const config = microMainnetConfigFromEnv(env);
  if (!config.requested || !config.configured) {
    throw new Error("turnkey-approval-probe-config-invalid");
  }
  const privateKey = String(env.TURNKEY_SIGNING_VERIFY_API_PRIVATE_KEY || "");
  const token = String(env.TURNKEY_MATRIX_TOKEN_ADDRESS || "");
  if (!privateKey || !token) throw new Error("turnkey-approval-probe-private-config-required");
  const client = makeClient ? makeClient(config, privateKey) : new Turnkey({
    apiBaseUrl: "https://api.turnkey.com", defaultOrganizationId: config.organizationId,
    apiPublicKey: config.apiPublicKey, apiPrivateKey: privateKey,
  }).apiClient();

  const policy = await verifyPolicy({ config,
    getWhoami: (request) => client.getWhoami(request),
    getOrganizationConfigs: (request) => client.getOrganizationConfigs(request),
    getPolicies: (request) => client.getPolicies(request),
    getUser: (request) => client.getUser(request),
  });
  if (!policy?.verified || !policy.userId) {
    throw new Error(`turnkey-approval-probe-policy-verification-failed:${
      (policy?.failures || ["unknown"]).join(",")}`);
  }

  const entry = buildTurnkeyBehavioralCases(config, token).allows
    .find((candidate) => candidate.case === "approval");
  if (!entry) throw new Error("turnkey-approval-probe-case-missing");
  const activityId = await submitActivity(client, config, entry, true);
  const activity = await client.getActivity({ organizationId: config.organizationId, activityId });
  const verified = await verifyActivity({ activity, entry, config,
    signingUserId: policy.userId });
  if (!verified?.verified) {
    throw new Error(`turnkey-approval-probe-activity-verification-failed:${
      (verified?.failures || ["unknown"]).join(",")}`);
  }
  return Object.freeze({ verified: true, case: "approval", activityId,
    activityCount: 1, broadcastCount: 0 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${JSON.stringify(await runTurnkeyApprovalProbe(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
