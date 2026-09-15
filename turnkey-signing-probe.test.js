import test from "node:test";
import assert from "node:assert/strict";
import {
  assessTurnkeySigningPolicy, expectedTurnkeySigningPolicy, probeTurnkeySigningPolicy,
} from "./turnkey-signing-probe.js";

const userId = "11111111-1111-7111-8111-111111111111";
const config = {
  policyId: "22222222-2222-7222-8222-222222222222",
  walletAddress: "0x3333333333333333333333333333333333333333",
  apiPublicKey: `02${"ab".repeat(32)}`,
  allowedRouters: ["0x4444444444444444444444444444444444444444"],
  maxPerTransactionWei: "1000000000000000",
};

const input = () => {
  const expected = expectedTurnkeySigningPolicy(config, userId);
  return {
    config,
    whoami: { userId },
    organizationConfigs: { configs: { quorum: { userIds: [] } } },
    policies: { policies: [{ policyId: config.policyId, ...expected }] },
    user: { userId, userTags: [], apiKeys: [{ credential: { publicKey: config.apiPublicKey } }] },
  };
};

test("verifies only the exact scoped signing policy", () => {
  const result = assessTurnkeySigningPolicy(input());
  assert.equal(result.verified, true);
  assert.equal(result.attestedPolicyExact, true);
});

test("rejects root, broader conditions, and any additional applicable allow", () => {
  const root = input();
  root.organizationConfigs.configs.quorum.userIds = [userId];
  assert.ok(assessTurnkeySigningPolicy(root).failures.includes("turnkey-signing-user-in-root-quorum"));

  const broad = input();
  broad.policies.policies[0].condition = "true";
  assert.ok(assessTurnkeySigningPolicy(broad).failures.includes("turnkey-signing-policy-not-exact"));

  const extra = input();
  extra.policies.policies.push({ policyId: "extra", effect: "EFFECT_ALLOW",
    consensus: "", condition: "true" });
  assert.ok(assessTurnkeySigningPolicy(extra).failures
    .includes("turnkey-signing-additional-or-missing-allow-policy"));
});

test("probe binds the authenticated signing user to policy and key ownership", async () => {
  const values = input();
  const result = await probeTurnkeySigningPolicy({ config,
    getWhoami: async () => values.whoami,
    getOrganizationConfigs: async () => values.organizationConfigs,
    getPolicies: async () => values.policies,
    getUser: async () => ({ user: values.user }),
  });
  assert.equal(result.verified, true);
});
