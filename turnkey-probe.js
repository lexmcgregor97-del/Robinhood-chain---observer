const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
