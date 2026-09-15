import { envFlag } from "./runtime-flags.js";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PUBLIC_KEY = /^(?:0x)?[0-9a-fA-F]{66}$/;
const UINT = /^(0|[1-9][0-9]*)$/;

const value = (input) => String(input || "").trim();
const addresses = (input) => [...new Set(value(input).split(/[\s,]+/).filter(Boolean)
  .map((address) => address.toLowerCase()))];

export const MICRO_MAINNET_CONFIRMATION_PREFIX = "ENABLE_ATLAS_MICRO_MAINNET";

export function microMainnetConfigFromEnv(env = process.env) {
  const mode = value(env.ATLAS_EXECUTION_MODE || "PAPER_ONLY").toUpperCase();
  const enabled = envFlag(env.MICRO_MAINNET_ENABLED, false);
  const organizationId = value(env.TURNKEY_SIGNING_ORGANIZATION_ID);
  const walletAddress = value(env.TURNKEY_SIGNING_WALLET_ADDRESS).toLowerCase();
  const policyId = value(env.TURNKEY_SIGNING_POLICY_ID);
  const apiPublicKey = value(env.TURNKEY_SIGNING_API_PUBLIC_KEY).replace(/^0x/i, "");
  const apiPrivateKey = value(env.TURNKEY_SIGNING_API_PRIVATE_KEY);
  const allowedRouters = addresses(env.MICRO_MAINNET_V2_ROUTERS);
  const maxPerTransactionWei = value(env.MICRO_MAINNET_MAX_WETH_PER_TX_WEI);
  const maxDailyWei = value(env.MICRO_MAINNET_MAX_WETH_DAILY_WEI);
  const confirmation = value(env.MICRO_MAINNET_CONFIRMATION);
  const expectedConfirmation = walletAddress
    ? `${MICRO_MAINNET_CONFIRMATION_PREFIX}:4663:${walletAddress}` : null;
  const requested = mode === "MICRO_MAINNET" || enabled;
  const failures = [];

  if (!new Set(["PAPER_ONLY", "MICRO_MAINNET"]).has(mode)) failures.push("invalid-execution-mode");
  if (requested && mode !== "MICRO_MAINNET") failures.push("micro-mainnet-mode-required");
  if (requested && !enabled) failures.push("micro-mainnet-enable-flag-required");
  if (requested && !UUID.test(organizationId)) failures.push("signing-organization-id-invalid");
  if (requested && !ADDRESS.test(walletAddress)) failures.push("signing-wallet-address-invalid");
  if (requested && !UUID.test(policyId)) failures.push("signing-policy-id-invalid");
  if (requested && !PUBLIC_KEY.test(apiPublicKey)) failures.push("signing-api-public-key-invalid");
  if (requested && !apiPrivateKey) failures.push("signing-api-private-key-required");
  const observerOrganizationId = value(env.TURNKEY_ORGANIZATION_ID);
  const observerWalletAddress = value(env.TURNKEY_WALLET_ADDRESS).toLowerCase();
  const observerApiPublicKey = value(env.TURNKEY_API_PUBLIC_KEY).replace(/^0x/i, "");
  if (requested && organizationId !== observerOrganizationId) {
    failures.push("signing-organization-must-match-observer");
  }
  if (requested && walletAddress !== observerWalletAddress) {
    failures.push("signing-wallet-must-match-observer");
  }
  if (requested && apiPublicKey
      && apiPublicKey.toLowerCase() === observerApiPublicKey.toLowerCase()) {
    failures.push("separate-signing-api-key-required");
  }
  if (requested && (!allowedRouters.length || allowedRouters.some((address) => !ADDRESS.test(address)))) {
    failures.push("execution-router-allowlist-invalid");
  }
  if (requested && (!UINT.test(maxPerTransactionWei) || BigInt(maxPerTransactionWei) <= 0n)) {
    failures.push("transaction-spend-limit-invalid");
  }
  if (requested && (!UINT.test(maxDailyWei) || BigInt(maxDailyWei) <= 0n)) {
    failures.push("daily-spend-limit-invalid");
  }
  if (requested && UINT.test(maxPerTransactionWei) && UINT.test(maxDailyWei)
      && BigInt(maxDailyWei) < BigInt(maxPerTransactionWei)) {
    failures.push("daily-spend-limit-below-transaction-limit");
  }
  if (requested && confirmation !== expectedConfirmation) failures.push("activation-confirmation-mismatch");

  return Object.freeze({
    requested,
    configured: requested && failures.length === 0,
    mode,
    enabled,
    organizationId,
    walletAddress,
    policyId,
    apiPublicKey,
    apiPrivateKey,
    allowedRouters: Object.freeze(allowedRouters),
    maxPerTransactionWei,
    maxDailyWei,
    expectedConfirmation,
    failures: Object.freeze(failures),
  });
}

export function assessMicroMainnetActivation({
  config,
  liveReadiness,
  signingCredentialVerified = false,
  signingPolicyVerified = false,
  pendingExecutions = 0,
  submissionPathConnected = false,
} = {}) {
  const failures = [...(config?.failures || [])];
  if (config?.requested !== true) failures.push("micro-mainnet-not-requested");
  if (config?.configured !== true) failures.push("micro-mainnet-config-incomplete");
  if (liveReadiness?.eligibleForMicroMainnet !== true) failures.push("live-readiness-not-satisfied");
  if (signingCredentialVerified !== true) failures.push("signing-credential-not-verified");
  if (signingPolicyVerified !== true) failures.push("signing-policy-not-verified");
  if (submissionPathConnected !== true) failures.push("execution-submission-path-not-connected");
  if (!Number.isSafeInteger(Number(pendingExecutions)) || Number(pendingExecutions) !== 0) {
    failures.push("pending-execution-review-required");
  }
  return Object.freeze({
    armed: failures.length === 0,
    failures: Object.freeze([...new Set(failures)]),
  });
}

export function publicMicroMainnetConfig(config) {
  return Object.freeze({
    requested: config?.requested === true,
    configured: config?.configured === true,
    mode: config?.mode || "PAPER_ONLY",
    walletAddressConfigured: Boolean(config?.walletAddress),
    signingOrganizationConfigured: Boolean(config?.organizationId),
    signingPolicyConfigured: Boolean(config?.policyId),
    signingApiKeyConfigured: Boolean(config?.apiPublicKey && config?.apiPrivateKey),
    allowedRouterCount: config?.allowedRouters?.length || 0,
    maxPerTransactionWei: config?.maxPerTransactionWei || null,
    maxDailyWei: config?.maxDailyWei || null,
    failures: [...(config?.failures || [])],
  });
}
