import test from "node:test";
import assert from "node:assert/strict";
import {
  assessTurnkeyReadOnly, probeTurnkeyPolicy, probeTurnkeyWallet, turnkeyConfigFromEnv,
} from "./turnkey-probe.js";

const config = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  walletId: "22222222-2222-4222-8222-222222222222",
  walletAddress: "0x3333333333333333333333333333333333333333",
  policyId: "44444444-4444-4444-8444-444444444444",
  apiPublicKey: "public-key",
};

test("reports missing Turnkey configuration without exposing values", () => {
  const result = turnkeyConfigFromEnv({ TURNKEY_ORGANIZATION_ID: config.organizationId });
  assert.equal(result.configured, false);
  assert.ok(result.missing.includes("apiPrivateKey"));
  assert.ok(result.missing.includes("readOnlyAttested"));
  assert.equal(JSON.stringify(result.missing).includes(config.organizationId), false);
});

const userId = "55555555-5555-4555-8555-555555555555";
const policyInputs = (overrides = {}) => ({
  config,
  whoami: { userId },
  organizationConfigs: { configs: { quorum: { threshold: 1, userIds: [] } } },
  policies: { policies: [{ policyId: config.policyId, effect: "EFFECT_DENY",
    consensus: `approvers.any(user, user.id == '${userId}')`,
    condition: "activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2'" }] },
  user: { userId, userTags: [], apiKeys: [{ credential: { publicKey: config.apiPublicKey } }] },
  ...overrides,
});

test("verifies a non-root API user with no applicable signing allow", () => {
  const result = assessTurnkeyReadOnly(policyInputs());
  assert.equal(result.readOnlyVerified, true);
});

test("rejects root-quorum users and applicable signing allow policies", () => {
  const input = policyInputs();
  input.organizationConfigs.configs.quorum.userIds = [userId];
  input.policies.policies.push({ policyId: "allow", effect: "EFFECT_ALLOW",
    consensus: `approvers.any(user, user.id == '${userId}')`,
    condition: "activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2'" });
  const result = assessTurnkeyReadOnly(input);
  assert.equal(result.readOnlyVerified, false);
  assert.ok(result.failures.includes("turnkey-api-user-in-root-quorum"));
  assert.ok(result.failures.includes("turnkey-signing-allow-policy-present"));
});

test("policy probe binds whoami, organization quorum, policies, and API-key ownership", async () => {
  const input = policyInputs();
  const result = await probeTurnkeyPolicy({ config,
    getWhoami: async () => input.whoami,
    getOrganizationConfigs: async () => input.organizationConfigs,
    getPolicies: async () => input.policies,
    getUser: async () => ({ user: input.user }),
  });
  assert.equal(result.readOnlyVerified, true);
});

test("requires an explicit read-only policy attestation", () => {
  const result = turnkeyConfigFromEnv({
    TURNKEY_ORGANIZATION_ID: config.organizationId,
    TURNKEY_WALLET_ID: config.walletId,
    TURNKEY_WALLET_ADDRESS: config.walletAddress,
    TURNKEY_API_PUBLIC_KEY: "public",
    TURNKEY_API_PRIVATE_KEY: "private",
    TURNKEY_POLICY_ID: config.policyId,
    TURNKEY_READ_ONLY_ATTESTED: "true",
  });
  assert.equal(result.configured, true);
  assert.equal(result.identifiersValid, true);
  assert.equal(result.readOnlyAttested, true);
});

test("verifies the configured wallet and address through a read-only query", async () => {
  const result = await probeTurnkeyWallet({ config, getWalletAccounts: async () => ({
    accounts: [{ walletId: config.walletId, walletAccountId: "account-id",
      address: config.walletAddress.toUpperCase().replace("0X", "0x") }],
  }) });
  assert.deepEqual(result, { authenticated: true, walletVisible: true, addressMatch: true,
    walletAccountId: "account-id", accountCount: 1 });
});
