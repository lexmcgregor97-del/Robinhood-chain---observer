import test from "node:test";
import assert from "node:assert/strict";
import {
  assessMicroMainnetActivation, forbiddenRuntimeSecretFailures,
  microMainnetConfigFromEnv, publicMicroMainnetConfig,
} from "./micro-mainnet-config.js";

const wallet = "0x1111111111111111111111111111111111111111";
const router = "0x2222222222222222222222222222222222222222";
const configured = {
  ATLAS_EXECUTION_MODE: "MICRO_MAINNET",
  MICRO_MAINNET_ENABLED: "true",
  TURNKEY_SIGNING_ORGANIZATION_ID: "11111111-1111-7111-8111-111111111111",
  TURNKEY_SIGNING_WALLET_ADDRESS: wallet,
  TURNKEY_SIGNING_BUY_POLICY_ID: "22222222-2222-7222-8222-222222222222",
  TURNKEY_SIGNING_SELL_POLICY_ID: "33333333-3333-7333-8333-333333333333",
  TURNKEY_SIGNING_APPROVAL_POLICY_ID: "44444444-4444-7444-8444-444444444444",
  TURNKEY_SIGNING_API_PUBLIC_KEY: `02${"ab".repeat(32)}`,
  TURNKEY_ORGANIZATION_ID: "11111111-1111-7111-8111-111111111111",
  TURNKEY_WALLET_ADDRESS: wallet,
  TURNKEY_API_PUBLIC_KEY: `03${"cd".repeat(32)}`,
  MICRO_MAINNET_V2_ROUTERS: router,
  MICRO_MAINNET_MAX_WETH_PER_TX_WEI: "1000000000000000",
  MICRO_MAINNET_MAX_WETH_DAILY_WEI: "3000000000000000",
  MICRO_MAINNET_MAX_GAS: "400000",
  MICRO_MAINNET_MAX_FEE_PER_GAS_WEI: "2000000000",
  MICRO_MAINNET_CONFIRMATION: `ENABLE_ATLAS_MICRO_MAINNET:4663:${wallet}`,
};

test("defaults to inert PAPER_ONLY without requiring signing secrets", () => {
  const result = microMainnetConfigFromEnv({});
  assert.equal(result.requested, false);
  assert.equal(result.mode, "PAPER_ONLY");
  assert.deepEqual(result.failures, []);
  assert.equal(assessMicroMainnetActivation({ config: result }).armed, false);
});

test("requires an exact two-part activation ceremony and bounded spend", () => {
  const result = microMainnetConfigFromEnv(configured);
  assert.equal(result.configured, true);
  const activation = assessMicroMainnetActivation({
    config: result,
    liveReadiness: { eligibleForMicroMainnet: true },
    signingCredentialVerified: true,
    signingPolicyVerified: true,
    walletWethBalanceWei: "3000000000000000",
    pendingExecutions: 0,
    submissionPathConnected: true,
  });
  assert.equal(activation.armed, true);
  assert.ok(microMainnetConfigFromEnv({ ...configured,
    MICRO_MAINNET_CONFIRMATION: "yes" }).failures.includes("activation-confirmation-mismatch"));
  assert.ok(microMainnetConfigFromEnv({ ...configured,
    MICRO_MAINNET_MAX_WETH_DAILY_WEI: "1" }).failures
    .includes("daily-spend-limit-below-transaction-limit"));
});

test("keeps signing secrets out of public status", () => {
  const result = publicMicroMainnetConfig(microMainnetConfigFromEnv(configured));
  assert.equal(JSON.stringify(result).includes(configured.TURNKEY_SIGNING_API_PUBLIC_KEY), false);
  assert.equal(result.signingApiKeyConfigured, true);
});

test("web runtime refuses signing and attestation private keys", () => {
  assert.deepEqual(forbiddenRuntimeSecretFailures({}), []);
  assert.deepEqual(forbiddenRuntimeSecretFailures({
    TURNKEY_SIGNING_VERIFY_API_PRIVATE_KEY: "secret",
    TURNKEY_SIGNING_ATTESTATION_PRIVATE_KEY_PEM_B64: "secret",
  }), ["signing-private-key-must-not-be-configured",
    "attestation-private-key-must-not-be-configured"]);
});

test("never arms with pending execution state or incomplete independent checks", () => {
  const config = microMainnetConfigFromEnv(configured);
  const result = assessMicroMainnetActivation({
    config, liveReadiness: { eligibleForMicroMainnet: true },
    signingCredentialVerified: true, signingPolicyVerified: true,
    walletWethBalanceWei: "3000000000000000", pendingExecutions: 1,
    submissionPathConnected: true,
  });
  assert.equal(result.armed, false);
  assert.ok(result.failures.includes("pending-execution-review-required"));
});

test("loss bound is the funded wallet balance, capped at the daily budget", () => {
  const config = microMainnetConfigFromEnv(configured);
  const common = { config, liveReadiness: { eligibleForMicroMainnet: true },
    signingCredentialVerified: true, signingPolicyVerified: true,
    pendingExecutions: 0, submissionPathConnected: true };
  assert.ok(assessMicroMainnetActivation(common).failures
    .includes("wallet-balance-not-verified"));
  assert.ok(assessMicroMainnetActivation({ ...common,
    walletWethBalanceWei: "3000000000000001" }).failures
    .includes("wallet-balance-exceeds-daily-cap"));
  assert.equal(assessMicroMainnetActivation({ ...common,
    walletWethBalanceWei: "3000000000000000" }).armed, true);
});
