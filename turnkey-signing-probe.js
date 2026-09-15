import { ROBINHOOD } from "./chain-config.js";

const UUID_IN_EXPRESSION = /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/ig;

const compact = (input) => String(input || "").replace(/\s+/g, " ").trim();

function consensusMayIncludeUser(consensus, userId, userTags = []) {
  const expression = String(consensus || "");
  if (!expression.trim()) return true;
  if (expression.includes(userId)
      || userTags.some((tag) => expression.includes(String(tag)))) return true;
  const explicitIds = expression.match(UUID_IN_EXPRESSION) || [];
  return explicitIds.length === 0;
}

export function expectedTurnkeySigningPolicy(config, userId) {
  const routers = [...config.allowedRouters].map((router) => `'${router}'`).join(", ");
  const wallet = config.walletAddress.toLowerCase();
  const weth = ROBINHOOD.weth.toLowerCase();
  return Object.freeze({
    effect: "EFFECT_ALLOW",
    consensus: `approvers.any(user, user.id == '${userId}')`,
    condition: `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && wallet_account.address == '${wallet}' && eth.tx.chain_id == 4663 && eth.tx.value == 0 && eth.tx.to in [${routers}] && eth.tx.function_name == 'swapExactTokensForTokens' && eth.tx.contract_call_args['amountIn'] <= ${config.maxPerTransactionWei} && eth.tx.contract_call_args['amountIn'] > 0 && eth.tx.contract_call_args['amountOutMin'] > 0 && eth.tx.contract_call_args['path'][0] == '${weth}' && eth.tx.contract_call_args['path'].count() == 2 && eth.tx.contract_call_args['to'] == '${wallet}'`,
  });
}

export function assessTurnkeySigningPolicy({ config, whoami, organizationConfigs, policies, user }) {
  const userId = String(whoami?.userId || "");
  const apiKeys = Array.isArray(user?.apiKeys) ? user.apiKeys : [];
  const userTags = Array.isArray(user?.userTags) ? user.userTags : [];
  const apiKeyOwned = apiKeys.some((key) =>
    String(key?.credential?.publicKey || "").replace(/^0x/i, "").toLowerCase()
      === String(config?.apiPublicKey || "").replace(/^0x/i, "").toLowerCase());
  const rootUserIds = organizationConfigs?.configs?.quorum?.userIds || [];
  const rootQuorumMember = rootUserIds.includes(userId);
  const listedPolicies = Array.isArray(policies?.policies) ? policies.policies : [];
  const applicableAllows = listedPolicies.filter((policy) => policy?.effect === "EFFECT_ALLOW"
    && consensusMayIncludeUser(policy.consensus, userId, userTags));
  const attestedPolicy = listedPolicies.find((policy) => policy.policyId === config?.policyId);
  const expected = userId ? expectedTurnkeySigningPolicy(config, userId) : null;
  const attestedPolicyExact = Boolean(attestedPolicy && expected
    && attestedPolicy.effect === expected.effect
    && compact(attestedPolicy.consensus) === compact(expected.consensus)
    && compact(attestedPolicy.condition) === compact(expected.condition));
  const onlyAttestedAllowApplies = applicableAllows.length === 1
    && applicableAllows[0]?.policyId === config?.policyId;
  const failures = [];
  if (!userId) failures.push("turnkey-signing-user-unresolved");
  if (!apiKeyOwned) failures.push("turnkey-signing-api-key-ownership-unverified");
  if (rootQuorumMember) failures.push("turnkey-signing-user-in-root-quorum");
  if (!attestedPolicy) failures.push("turnkey-signing-policy-not-visible");
  else if (!attestedPolicyExact) failures.push("turnkey-signing-policy-not-exact");
  if (!onlyAttestedAllowApplies) failures.push("turnkey-signing-additional-or-missing-allow-policy");
  return Object.freeze({
    verified: failures.length === 0,
    apiKeyOwned,
    rootQuorumMember,
    attestedPolicyVisible: Boolean(attestedPolicy),
    attestedPolicyExact,
    applicableAllowPolicyCount: applicableAllows.length,
    userId: userId || null,
    failures: Object.freeze(failures),
  });
}

export async function probeTurnkeySigningPolicy({
  config, getWhoami, getOrganizationConfigs, getPolicies, getUser,
}) {
  if (![getWhoami, getOrganizationConfigs, getPolicies, getUser]
    .every((fn) => typeof fn === "function")) throw new Error("turnkey-signing-policy-client-required");
  const whoami = await getWhoami({ organizationId: config.organizationId });
  const [organizationConfigs, policies, user] = await Promise.all([
    getOrganizationConfigs({ organizationId: config.organizationId }),
    getPolicies({ organizationId: config.organizationId }),
    getUser({ organizationId: config.organizationId, userId: whoami.userId }),
  ]);
  return assessTurnkeySigningPolicy({ config, whoami, organizationConfigs, policies,
    user: user?.user || user });
}
