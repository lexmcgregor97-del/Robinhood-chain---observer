// RFC 9562 defines UUID versions through v8. Turnkey currently issues UUIDv7\n// identifiers, so rejecting versions newer than v5 blocks otherwise valid\n// organization, wallet, user, and policy IDs before the read-only probe runs.\nconst UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;

export function turnkeyConfigFromEnv(env = process.env) {
  const config = {
    organizationId: String(env.TURNKEY_ORGANIZATION_ID || ""),
    walletId: String(env.TURNKEY_WALLET_ID || ""),
    walletAddress: String(env.TURNKEY_WALLET_ADDRESS || "").toLowerCase(),
    apiPublicKey: String(env.TURNKEY_API_PUBLIC_KEY || ""),
    apiPrivateKey: String(env.TURNKEY_API_PRIVATE_KEY || ""),
    policyId: String(env.TURNKEY_POLICY_ID || ""),
  };
  const missing = Object.entries(config).filter(([, value]) => !value).map(([key]) => key);
  const readOnlyAttested = String(env.TURNKEY_READ_ONLY_ATTESTED || "").toLowerCase() === "true";
  if (!readOnlyAttested) missing.push("readOnlyAttested");
  return {
    config, configured: missing.length === 0, missing, readOnlyAttested,
    identifiersValid: UUID.test(config.organizationId) && UUID.test(config.walletId)
      && UUID.test(config.policyId) && ADDRESS.test(config.walletAddress),
  };
}

export async function probeTurnkeyWallet({ config, getWalletAccounts }) {
  if (typeof getWalletAccounts !== "function") throw new Error("turnkey-client-required");
  const response = await getWalletAccounts({ organizationId: config.organizationId,
    walletId: config.walletId });
  const accounts = Array.isArray(response?.accounts) ? response.accounts : [];
  const account = accounts.find((item) =>
    String(item.address || "").toLowerCase() === config.walletAddress);
  return {
    authenticated: true,
    walletVisible: accounts.some((item) => item.walletId === config.walletId),
    addressMatch: Boolean(account),
    walletAccountId: account?.walletAccountId || null,
    accountCount: accounts.length,
  };
}

const UUID_IN_EXPRESSION = /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/ig;

function consensusMayIncludeUser(consensus, userId, userTags = []) {
  const expression = String(consensus || "");
  if (!expression.trim()) return true;
  if (expression.includes(userId)
      || userTags.some((tag) => expression.includes(String(tag)))) return true;
  const explicitIds = expression.match(UUID_IN_EXPRESSION) || [];
  return explicitIds.length === 0;
}

export function assessTurnkeyReadOnly({ config, whoami, organizationConfigs, policies, user }) {
  const userId = String(whoami?.userId || "");
  const apiKeys = Array.isArray(user?.apiKeys) ? user.apiKeys : [];
  const userTags = Array.isArray(user?.userTags) ? user.userTags : [];
  const apiKeyOwned = apiKeys.some((key) =>
    String(key?.credential?.publicKey || "").toLowerCase()
      === String(config?.apiPublicKey || "").toLowerCase());
  const rootUserIds = organizationConfigs?.configs?.quorum?.userIds || [];
  const rootQuorumMember = rootUserIds.includes(userId);
  const listedPolicies = Array.isArray(policies?.policies) ? policies.policies : [];
  const attestedPolicy = listedPolicies.find((policy) => policy.policyId === config?.policyId);
  const attestedPolicyVisible = Boolean(attestedPolicy);
  const attestedDenyPolicyValid = attestedPolicy?.effect === "EFFECT_DENY"
    && consensusMayIncludeUser(attestedPolicy.consensus, userId, userTags);
  const applicableAllowPolicies = listedPolicies.filter((policy) =>
    policy?.effect === "EFFECT_ALLOW"
      && consensusMayIncludeUser(policy.consensus, userId, userTags));
  const failures = [];
  if (!userId) failures.push("turnkey-user-unresolved");
  if (!apiKeyOwned) failures.push("turnkey-api-key-ownership-unverified");
  if (rootQuorumMember) failures.push("turnkey-api-user-in-root-quorum");
  if (!attestedPolicyVisible) failures.push("turnkey-policy-not-visible");
  if (attestedPolicyVisible && !attestedDenyPolicyValid) failures.push("turnkey-attested-deny-policy-invalid");
  if (applicableAllowPolicies.length) failures.push("turnkey-applicable-allow-policy-present");
  return {
    readOnlyVerified: failures.length === 0,
    apiKeyOwned,
    rootQuorumMember,
    attestedPolicyVisible,
    attestedDenyPolicyValid,
    applicableAllowPolicyCount: applicableAllowPolicies.length,
    failures,
  };
}

export async function probeTurnkeyPolicy({
  config, getWhoami, getOrganizationConfigs, getPolicies, getUser,
}) {
  if (![getWhoami, getOrganizationConfigs, getPolicies, getUser]
    .every((fn) => typeof fn === "function")) throw new Error("turnkey-policy-client-required");
  const whoami = await getWhoami({ organizationId: config.organizationId });
  const [organizationConfigs, policies, user] = await Promise.all([
    getOrganizationConfigs({ organizationId: config.organizationId }),
    getPolicies({ organizationId: config.organizationId }),
    getUser({ organizationId: config.organizationId, userId: whoami.userId }),
  ]);
  return assessTurnkeyReadOnly({ config, whoami, organizationConfigs, policies,
    user: user?.user || user });
}
