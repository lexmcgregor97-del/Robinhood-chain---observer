import { Turnkey } from "@turnkey/sdk-server";
import { pathToFileURL } from "node:url";
import { microMainnetConfigFromEnv } from "./micro-mainnet-config.js";
import { probeTurnkeySigningPolicy } from "./turnkey-signing-probe.js";
import { createSigningAttestation, writeSigningAttestation } from "./signing-attestation.js";

export async function verifySigningPolicyOneShot(env = process.env, {
  makeClient, writeAttestation = writeSigningAttestation,
} = {}) {
  const config = microMainnetConfigFromEnv(env);
  const signingPrivateKey = String(env.TURNKEY_SIGNING_VERIFY_API_PRIVATE_KEY || "");
  const observerPrivateKey = String(env.TURNKEY_API_PRIVATE_KEY || "");
  const failures = [...config.failures];
  if (!config.requested || !config.configured) failures.push("micro-mainnet-config-incomplete");
  if (!signingPrivateKey) failures.push("one-shot-signing-private-key-required");
  if (!observerPrivateKey) failures.push("observer-private-key-required-for-user-separation");
  if (failures.length) return { verified: false, distinctUsers: false,
    policyVerified: false, failures: [...new Set(failures)] };

  const factory = makeClient || (({ apiPublicKey, apiPrivateKey }) => new Turnkey({
    apiBaseUrl: "https://api.turnkey.com",
    defaultOrganizationId: config.organizationId,
    apiPublicKey,
    apiPrivateKey,
  }).apiClient());
  const signing = factory({ apiPublicKey: config.apiPublicKey,
    apiPrivateKey: signingPrivateKey });
  const observer = factory({ apiPublicKey: String(env.TURNKEY_API_PUBLIC_KEY || ""),
    apiPrivateKey: observerPrivateKey });
  try {
    const signingPolicy = await probeTurnkeySigningPolicy({ config,
      getWhoami: (request) => signing.getWhoami(request),
      getOrganizationConfigs: (request) => signing.getOrganizationConfigs(request),
      getPolicies: (request) => signing.getPolicies(request),
      getUser: (request) => signing.getUser(request),
    });
    const observerIdentity = await observer.getWhoami({ organizationId: config.organizationId });
    const distinctUsers = Boolean(signingPolicy.userId && observerIdentity?.userId
      && signingPolicy.userId !== observerIdentity.userId);
    if (!distinctUsers) failures.push("observer-and-signing-users-must-differ");
    failures.push(...signingPolicy.failures);
    let attestationWritten = false;
    const attestationPath = String(env.TURNKEY_SIGNING_ATTESTATION_FILE || "");
    const attestationPrivateKey = String(env.TURNKEY_SIGNING_ATTESTATION_PRIVATE_KEY_PEM_B64 || "");
    if (attestationPath || attestationPrivateKey) {
      if (!attestationPath || !attestationPrivateKey) {
        failures.push("signing-attestation-output-incomplete");
      } else if (signingPolicy.verified && distinctUsers) {
        try {
          const issuedAt = Date.now();
          const ttlMs = Number(env.TURNKEY_SIGNING_ATTESTATION_TTL_MS || 6 * 60 * 60_000);
          const document = createSigningAttestation({ config,
            signingUserId: signingPolicy.userId,
            observerUserId: observerIdentity.userId,
            privateKeyPem: Buffer.from(attestationPrivateKey, "base64").toString("utf8"),
            issuedAt, expiresAt: issuedAt + ttlMs });
          await writeAttestation(attestationPath, document);
          attestationWritten = true;
        } catch {
          failures.push("signing-attestation-write-failed");
        }
      }
    }
    return {
      verified: signingPolicy.verified && distinctUsers && failures.length === 0,
      distinctUsers,
      policyVerified: signingPolicy.verified,
      attestationWritten,
      apiKeyOwned: signingPolicy.apiKeyOwned,
      rootQuorumMember: signingPolicy.rootQuorumMember,
      expectedPolicySetExact: signingPolicy.expectedPolicySetExact,
      applicableAllowPolicyCount: signingPolicy.applicableAllowPolicyCount,
      failures: [...new Set(failures)],
    };
  } catch {
    return { verified: false, distinctUsers: false, policyVerified: false,
      attestationWritten: false,
      failures: ["one-shot-signing-verification-failed"] };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await verifySigningPolicyOneShot();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.verified) process.exitCode = 1;
}
