import { envFlag } from "./runtime-flags.js";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PUBLIC_KEY = /^(?:0x)?[0-9a-fA-F]{66}$/;
const UINT = /^(0|[1-9][0-9]*)$/;

const value = (input) => String(input || "").trim();
const addresses = (input) => [...new Set(value(input).split(/[\s,]+/).filter(Boolean)
  .map((address) => address.toLowerCase()))];

export const MICRO_MAINNET_CONFIRMATION_PREFIX = "ENABLE_ATLAS_MICRO_MAINNET";

export function forbiddenRuntimeSecretFailures(env = process.env) {
  const signingSecrets = [
    "TURNKEY_SIGNING_API_PRIVATE_KEY",
    "TURNKEY_SIGNING_VERIFY_API_PRIVATE_KEY",
  ];
  const failures = [];
  if (signingSecrets.some((name) => value(env[name]))) {
    failures.push("signing-private-key-must-not-be-configured");
  }
  if (value(env.TURNKEY_SIGNING_ATTESTATION_PRIVATE_KEY_PEM_B64)) {
    failures.push("attestation-private-key-must-not-be-configured");
  }
  return Object.freeze(failures);
}

export function microMainnetConfigFromEnv(env = process.env) {
  const mode = value(env.ATLAS_EXECUTION_MODE || "PAPER_ONLY").toUpperCase();
  const enabled = envFlag(env.MICRO_MAINNET_ENABLED, false);
  const organizationId = value(env.TURNKEY_SIGNING_ORGANIZATION_ID);
  // Turnkey treats `signWith` addresses as case-sensitive resource locators.
  // Preserve the configured spelling for SDK calls while retaining the
  // normalized address used by policy and EVM comparisons.
  const walletSignWith = value(env.TURNKEY_SIGNING_WALLET_ADDRESS);
  const walletAddress = walletSignWith.toLowerCase();
  const buyPolicyId = value(env.TURNKEY_SIGNING_BUY_POLICY_ID);
  const sellPolicyId = value(env.TURNKEY_SIGNING_SELL_POLICY_ID);
  const approvalPolicyId = value(env.TURNKEY_SIGNING_APPROVAL_POLICY_ID);
  const apiPublicKey = value(env.TURNKEY_SIGNING_API_PUBLIC_KEY).replace(/^0x/i, "");
  const allowedRouters = addresses(env.MICRO_MAINNET_V2_ROUTERS);
  const maxPerTransactionWei = value(env.MICRO_MAINNET_MAX_WETH_PER_TX_WEI);
  const maxDailyWei = value(env.MICRO_MAINNET_MAX_WETH_DAILY_WEI);
  const maxGas = value(env.MICRO_MAINNET_MAX_GAS);
  const maxFeePerGasWei = value(env.MICRO_MAINNET_MAX_FEE_PER_GAS_WEI);
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
  const policyIds = [buyPolicyId, sellPolicyId, approvalPolicyId];
  if (requested && (policyIds.some((id) => !UUID.test(id))
      || new Set(policyIds).size !== policyIds.length)) failures.push("signing-policy-ids-invalid");
  if (requested && !PUBLIC_KEY.test(apiPublicKey)) failures.push("signing-api-public-key-invalid");
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
  if (requested && (!UINT.test(maxGas) || BigInt(maxGas) <= 0n)) failures.push("max-gas-invalid");
  if (requested && (!UINT.test(maxFeePerGasWei) || BigInt(maxFeePerGasWei) <= 0n)) {
    failures.push("max-fee-per-gas-invalid");
  }
  if (requested && confirmation !== expectedConfirmation) failures.push("activation-confirmation-mismatch");

  return Object.freeze({
    requested,
    configured: requested && failures.length === 0,
    mode,
    enabled,
    organizationId,
    walletAddress,
    walletSignWith,
    policyIds: Object.freeze({ buy: buyPolicyId, sell: sellPolicyId, approval: approvalPolicyId }),
    apiPublicKey,
    allowedRouters: Object.freeze(allowedRouters),
    maxPerTransactionWei,
    maxDailyWei,
    maxGas,
    maxFeePerGasWei,
    expectedConfirmation,
    failures: Object.freeze(failures),
  });
}

export function assessMicroMainnetActivation({
  config,
  liveReadiness,
  signingCredentialVerified = false,
  signingPolicyVerified = false,
  walletWethBalanceWei = null,
  pendingExecutions = 0,
  submissionPathConnected = false,
} = {}) {
  const failures = [...(config?.failures || [])];
  if (config?.requested !== true) failures.push("micro-mainnet-not-requested");
  if (config?.configured !== true) failures.push("micro-mainnet-config-incomplete");
  if (liveReadiness?.eligibleForMicroMainnet !== true) failures.push("live-readiness-not-satisfied");
  if (signingCredentialVerified !== true) failures.push("signing-credential-not-verified");
  if (signingPolicyVerified !== true) failures.push("signing-policy-not-verified");
  if (config?.requested === true) {
    const balance = String(walletWethBalanceWei ?? "");
    if (!UINT.test(balance)) failures.push("wallet-balance-not-verified");
    else if (UINT.test(config?.maxDailyWei) && BigInt(balance) > BigInt(config.maxDailyWei)) {
      failures.push("wallet-balance-exceeds-daily-cap");
    }
  }
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
    signingPolicyConfigured: Boolean(config?.policyIds
      && Object.values(config.policyIds).every(Boolean)),
    signingApiKeyConfigured: Boolean(config?.apiPublicKey),
    allowedRouterCount: config?.allowedRouters?.length || 0,
    maxPerTransactionWei: config?.maxPerTransactionWei || null,
    maxDailyWei: config?.maxDailyWei || null,
    maxGas: config?.maxGas || null,
    maxFeePerGasWei: config?.maxFeePerGasWei || null,
    failures: [...(config?.failures || [])],
  });
}
