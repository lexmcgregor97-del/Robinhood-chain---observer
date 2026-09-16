import test from "node:test";
import assert from "node:assert/strict";
import {
  assessTurnkeySigningPolicy, expectedTurnkeySigningPolicies, probeTurnkeySigningPolicy,
} from "./turnkey-signing-probe.js";

const userId = "11111111-1111-7111-8111-111111111111";
const config = {
  policyIds: {
    buy: "22222222-2222-7222-8222-222222222222",
    sell: "33333333-3333-7333-8333-333333333333",
    approval: "44444444-4444-7444-8444-444444444444",
  },
  walletAddress: "0x910136966075758a269d670b426459fce098c177",
  apiPublicKey: `02${"ab".repeat(32)}`,
  allowedRouters: ["0x89e5db8b5aa49aa85ac63f691524311aeb649eba"],
  maxPerTransactionWei: "1000000000000000",
  maxGas: "400000",
  maxFeePerGasWei: "2000000000",
};

const input = () => {
  const expected = expectedTurnkeySigningPolicies(config, userId);
  return {
    config,
    whoami: { userId },
    organizationConfigs: { configs: { quorum: { userIds: [] } } },
    policies: { policies: Object.entries(expected).map(([kind, policy]) => ({
      policyId: config.policyIds[kind], ...policy,
    })) },
    user: { userId, userTags: [], apiKeys: [{ credential: { publicKey: config.apiPublicKey } }] },
  };
};

test("verifies only the exact scoped signing policy", () => {
  const result = assessTurnkeySigningPolicy(input());
  assert.equal(result.verified, true);
  assert.equal(result.expectedPolicySetExact, true);
});

test("rejects root, broader conditions, and any additional applicable allow", () => {
  const root = input();
  root.organizationConfigs.configs.quorum.userIds = [userId];
  assert.ok(assessTurnkeySigningPolicy(root).failures.includes("turnkey-signing-user-in-root-quorum"));

  const broad = input();
  broad.policies.policies[0].condition = "true";
  assert.ok(assessTurnkeySigningPolicy(broad).failures.includes("turnkey-signing-policy-set-not-exact"));

  const extra = input();
  extra.policies.policies.push({ policyId: "extra", effect: "EFFECT_ALLOW",
    consensus: "", condition: "true" });
  assert.ok(assessTurnkeySigningPolicy(extra).failures
    .includes("turnkey-signing-applicable-allow-set-mismatch"));
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

test("approval policy pins selector and padded allowlisted spender word", () => {
  const approval = expectedTurnkeySigningPolicies(config, userId).approval.condition;
  const paddedRouter = config.allowedRouters[0].slice(2).padStart(64, "0");
  assert.match(approval, /eth\.tx\.data\[0\.\.10\] == '0x095ea7b3'/);
  assert.ok(approval.includes(`eth.tx.data[10..74] in ['${paddedRouter}']`));
  assert.equal(approval.includes("0x5555555555555555555555555555555555555555"), false);
});

test("renders decoded EVM address predicates with canonical checksum casing", () => {
  const policies = expectedTurnkeySigningPolicies(config, userId);
  assert.match(policies.buy.condition,
    /wallet_account\.address == '0x910136966075758A269D670B426459fCE098c177'/);
  assert.match(policies.buy.condition,
    /eth\.tx\.to in \['0x89e5DB8B5aA49aA85AC63f691524311AEB649eba'\]/);
  assert.match(policies.buy.condition,
    /contract_call_args\['to'\] == '0x910136966075758A269D670B426459fCE098c177'/);
  assert.match(policies.buy.condition,
    /contract_call_args\['path'\]\[0\] == '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'/);
});
