import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { expectedTurnkeySigningPolicies } from "./turnkey-signing-probe.js";
import { verifySigningPolicyOneShot } from "./verify-signing-policy.js";
import { verifySigningAttestation } from "./signing-attestation.js";

const signingUser = "11111111-1111-7111-8111-111111111111";
const observerUser = "22222222-2222-7222-8222-222222222222";
const wallet = "0x3333333333333333333333333333333333333333";
const env = {
  ATLAS_EXECUTION_MODE: "MICRO_MAINNET", MICRO_MAINNET_ENABLED: "true",
  TURNKEY_SIGNING_ORGANIZATION_ID: "33333333-3333-7333-8333-333333333333",
  TURNKEY_ORGANIZATION_ID: "33333333-3333-7333-8333-333333333333",
  TURNKEY_SIGNING_WALLET_ADDRESS: wallet, TURNKEY_WALLET_ADDRESS: wallet,
  TURNKEY_SIGNING_BUY_POLICY_ID: "44444444-4444-7444-8444-444444444444",
  TURNKEY_SIGNING_SELL_POLICY_ID: "55555555-5555-7555-8555-555555555555",
  TURNKEY_SIGNING_APPROVAL_POLICY_ID: "66666666-6666-7666-8666-666666666666",
  TURNKEY_SIGNING_API_PUBLIC_KEY: `02${"ab".repeat(32)}`,
  TURNKEY_API_PUBLIC_KEY: `03${"cd".repeat(32)}`,
  TURNKEY_SIGNING_VERIFY_API_PRIVATE_KEY: "signing-secret",
  TURNKEY_API_PRIVATE_KEY: "observer-secret",
  MICRO_MAINNET_V2_ROUTERS: "0x7777777777777777777777777777777777777777",
  MICRO_MAINNET_MAX_WETH_PER_TX_WEI: "1000", MICRO_MAINNET_MAX_WETH_DAILY_WEI: "3000",
  MICRO_MAINNET_MAX_GAS: "400000", MICRO_MAINNET_MAX_FEE_PER_GAS_WEI: "2000000000",
  MICRO_MAINNET_CONFIRMATION: `ENABLE_ATLAS_MICRO_MAINNET:4663:${wallet}`,
};

function clients({ sameUser = false } = {}) {
  let calls = 0;
  return () => {
    calls += 1;
    if (calls === 2) return { getWhoami: async () => ({ userId: sameUser ? signingUser : observerUser }) };
    return {
      getWhoami: async () => ({ userId: signingUser }),
      getOrganizationConfigs: async () => ({ configs: { quorum: { userIds: [] } } }),
      getPolicies: async () => {
        const parsed = {
          allowedRouters: [env.MICRO_MAINNET_V2_ROUTERS], walletAddress: wallet,
          maxPerTransactionWei: "1000", maxGas: "400000", maxFeePerGasWei: "2000000000",
        };
        const policies = expectedTurnkeySigningPolicies(parsed, signingUser);
        return { policies: Object.entries(policies).map(([kind, policy]) => ({
          policyId: { buy: env.TURNKEY_SIGNING_BUY_POLICY_ID,
            sell: env.TURNKEY_SIGNING_SELL_POLICY_ID,
            approval: env.TURNKEY_SIGNING_APPROVAL_POLICY_ID }[kind], ...policy,
        })) };
      },
      getUser: async () => ({ user: { userId: signingUser, userTags: [],
        apiKeys: [{ credential: { publicKey: env.TURNKEY_SIGNING_API_PUBLIC_KEY } }] } }),
    };
  };
}

test("one-shot verification proves exact policy and distinct API users", async () => {
  const result = await verifySigningPolicyOneShot(env, { makeClient: clients() });
  assert.equal(result.verified, true);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("one-shot verification rejects one user holding both credentials", async () => {
  const result = await verifySigningPolicyOneShot(env, { makeClient: clients({ sameUser: true }) });
  assert.equal(result.verified, false);
  assert.ok(result.failures.includes("observer-and-signing-users-must-differ"));
});

test("one-shot verification can emit a signed, expiring, config-bound attestation", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" } });
  let written = null;
  const matrix = { runAt: Date.now(), allows: [], denials: [] };
  const normalized = { runAt: matrix.runAt,
    allows: ["allow-buy", "allow-sell", "allow-approval", "allow-reset"],
    denials: Array.from({ length: 12 }, (_, index) => `deny-${index + 1}`) };
  const configured = { ...env, TURNKEY_SIGNING_ATTESTATION_FILE: "/tmp/not-written",
    TURNKEY_SIGNING_BEHAVIORAL_MATRIX_FILE: "/tmp/matrix.json",
    TURNKEY_SIGNING_ATTESTATION_PRIVATE_KEY_PEM_B64: Buffer.from(privateKey).toString("base64") };
  const result = await verifySigningPolicyOneShot(configured, { makeClient: clients(),
    readMatrix: async () => JSON.stringify(matrix),
    verifyMatrix: async () => ({ verified: true, normalized, failures: [] }),
    writeAttestation: async (_path, document) => { written = document; } });
  assert.equal(result.verified, true);
  assert.equal(result.attestationWritten, true);
  const parsed = (await import("./micro-mainnet-config.js")).microMainnetConfigFromEnv(configured);
  assert.equal(verifySigningAttestation({ document: written, config: parsed,
    publicKeyPem: publicKey }).verified, true);
  assert.equal(written.claims.behavioralMatrix.denials, 12);
  assert.equal(written.claims.behavioralMatrix.allows, 4);
});

test("one-shot refuses to attest without a behavioral matrix", async () => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" } });
  const configured = { ...env, TURNKEY_SIGNING_ATTESTATION_FILE: "/tmp/not-written",
    TURNKEY_SIGNING_ATTESTATION_PRIVATE_KEY_PEM_B64: Buffer.from(privateKey).toString("base64") };
  const result = await verifySigningPolicyOneShot(configured, { makeClient: clients() });
  assert.equal(result.verified, false);
  assert.equal(result.attestationWritten, false);
  assert.deepEqual(result.failures, ["signing-attestation-output-incomplete"]);
});
