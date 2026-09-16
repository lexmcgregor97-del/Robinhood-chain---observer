import { ROBINHOOD } from "./chain-config.js";
import { getAddress } from "viem";

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

export function expectedTurnkeySigningPolicies(config, userId) {
  // Turnkey policy string equality is exact. Render decoded EVM address
  // operands in canonical checksum form, matching the values exposed by the
  // EVM parser. Raw calldata slices remain lowercase hexadecimal.
  // Turnkey's `in` operator is for integer fields. Address and calldata
  // operands are strings, so an allowlist must be expressed as exact equality
  // clauses joined with `||`.
  const routerCondition = [...config.allowedRouters]
    .map((router) => `eth.tx.to == '${getAddress(router)}'`).join(" || ");
  const routerWordCondition = [...config.allowedRouters]
    .map((router) => `eth.tx.data[10..74] == '${router.slice(2).toLowerCase().padStart(64, "0")}'`)
    .join(" || ");
  const wallet = getAddress(config.walletAddress);
  // Turnkey documents count/all/any for flat ABI arrays, but not direct
  // indexing. Bind the two-token path orientation to the canonical ABI
  // calldata words instead. For swapExactTokensForTokens the dynamic path
  // begins after five head words: length at data[330..394], token 0 at
  // data[394..458], and token 1 at data[458..522]. The decoded count check
  // below independently requires exactly two path elements.
  const wethWord = ROBINHOOD.weth.slice(2).toLowerCase().padStart(64, "0");
  const common = `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && wallet_account.address == '${wallet}' && eth.tx.chain_id == 4663 && eth.tx.value == 0 && eth.tx.gas <= ${config.maxGas} && eth.tx.max_fee_per_gas <= ${config.maxFeePerGasWei} && eth.tx.max_priority_fee_per_gas <= ${config.maxFeePerGasWei}`;
  const swap = `${common} && (${routerCondition}) && eth.tx.function_name == 'swapExactTokensForTokens' && eth.tx.contract_call_args['amountIn'] > 0 && eth.tx.contract_call_args['amountOutMin'] > 0 && eth.tx.contract_call_args['path'].count() == 2 && eth.tx.contract_call_args['to'] == '${wallet}'`;
  const consensus = `approvers.any(user, user.id == '${userId}')`;
  return Object.freeze({
    buy: Object.freeze({ effect: "EFFECT_ALLOW", consensus,
      condition: `${swap} && eth.tx.contract_call_args['amountIn'] <= ${config.maxPerTransactionWei} && eth.tx.data[394..458] == '${wethWord}'` }),
    sell: Object.freeze({ effect: "EFFECT_ALLOW", consensus,
      condition: `${swap} && eth.tx.data[458..522] == '${wethWord}'` }),
    approval: Object.freeze({ effect: "EFFECT_ALLOW", consensus,
      condition: `${common} && eth.tx.data[0..10] == '0x095ea7b3' && (${routerWordCondition})` }),
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
  const expected = userId ? expectedTurnkeySigningPolicies(config, userId) : null;
  const expectedEntries = expected ? Object.entries(expected) : [];
  const policyChecks = Object.fromEntries(expectedEntries.map(([kind, expectedPolicy]) => {
    const policyId = config?.policyIds?.[kind];
    const policy = listedPolicies.find((candidate) => candidate.policyId === policyId);
    return [kind, Object.freeze({
      policyId,
      visible: Boolean(policy),
      exact: Boolean(policy
        && policy.effect === expectedPolicy.effect
        && compact(policy.consensus) === compact(expectedPolicy.consensus)
        && compact(policy.condition) === compact(expectedPolicy.condition)),
    })];
  }));
  const exactPolicyIds = new Set(Object.values(config?.policyIds || {}));
  const expectedPolicySetExact = Object.values(policyChecks).length === 3
    && Object.values(policyChecks).every((check) => check.visible && check.exact)
    && applicableAllows.length === 3
    && applicableAllows.every((policy) => exactPolicyIds.has(policy.policyId));
  const failures = [];
  if (!userId) failures.push("turnkey-signing-user-unresolved");
  if (!apiKeyOwned) failures.push("turnkey-signing-api-key-ownership-unverified");
  if (rootQuorumMember) failures.push("turnkey-signing-user-in-root-quorum");
  if (!Object.values(policyChecks).every((check) => check.visible)) {
    failures.push("turnkey-signing-policy-set-not-visible");
  }
  if (Object.values(policyChecks).some((check) => check.visible && !check.exact)) {
    failures.push("turnkey-signing-policy-set-not-exact");
  }
  if (!expectedPolicySetExact) failures.push("turnkey-signing-applicable-allow-set-mismatch");
  return Object.freeze({
    verified: failures.length === 0,
    apiKeyOwned,
    rootQuorumMember,
    policyChecks,
    expectedPolicySetExact,
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
