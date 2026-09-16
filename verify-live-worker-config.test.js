import test from "node:test";
import assert from "node:assert/strict";
import { verifyDormantLiveWorkerConfig } from "./verify-live-worker-config.js";

const wallet = "0x1111111111111111111111111111111111111111";
const base = {
  ATLAS_EXECUTION_MODE: "MICRO_MAINNET",
  MICRO_MAINNET_ENABLED: "true",
  MICRO_MAINNET_CONFIRMATION: `ENABLE_ATLAS_MICRO_MAINNET:4663:${wallet}`,
  MICRO_MAINNET_MAX_FEE_PER_GAS_WEI: "2000000000",
  MICRO_MAINNET_MAX_GAS: "400000",
  MICRO_MAINNET_MAX_WETH_DAILY_WEI: "3000",
  MICRO_MAINNET_MAX_WETH_PER_TX_WEI: "1000",
  MICRO_MAINNET_V2_ROUTERS: "0x2222222222222222222222222222222222222222",
  TURNKEY_SIGNING_ORGANIZATION_ID: "11111111-1111-7111-8111-111111111111",
  TURNKEY_ORGANIZATION_ID: "11111111-1111-7111-8111-111111111111",
  TURNKEY_SIGNING_WALLET_ADDRESS: wallet,
  TURNKEY_WALLET_ADDRESS: wallet,
  TURNKEY_SIGNING_API_PUBLIC_KEY: `02${"ab".repeat(32)}`,
  TURNKEY_API_PUBLIC_KEY: `03${"cd".repeat(32)}`,
  TURNKEY_SIGNING_API_PRIVATE_KEY: "private-but-never-read-or-returned",
  TURNKEY_SIGNING_BUY_POLICY_ID: "22222222-2222-7222-8222-222222222222",
  TURNKEY_SIGNING_SELL_POLICY_ID: "33333333-3333-7333-8333-333333333333",
  TURNKEY_SIGNING_APPROVAL_POLICY_ID: "44444444-4444-7444-8444-444444444444",
  ATLAS_OBSERVER_URL: "https://observer.example",
  LIVE_WORKER_OBSERVER_HOSTNAME: "observer.example",
  LIVE_WORKER_OBSERVER_BEARER_TOKEN: "a".repeat(64),
  LIVE_WORKER_STATE_FILE: "/data/state.json",
  LIVE_WORKER_EVIDENCE_FILE: "/data/evidence.jsonl",
  LIVE_WORKER_V2_ROUTER_ADDRESS: "0x2222222222222222222222222222222222222222",
  LIVE_WORKER_BUY_AMOUNT_WEI: "1000",
  LIVE_WORKER_MAX_ALLOWANCE_WEI: "1000",
  LIVE_WORKER_MIN_NATIVE_BALANCE_WEI: "1",
  LIVE_WORKER_SUBMISSION_CONNECTED: "false",
  LIVE_WORKER_AUTOMATIC_SUBMISSION_ENABLED: "false",
};

test("verifies resolved dormant configuration without exposing private material", () => {
  const result = verifyDormantLiveWorkerConfig(base);
  assert.equal(result.verified, true);
  assert.equal(result.connected, false);
  assert.equal(result.automatic, false);
  assert.equal(result.signingCredentialPresent, true);
  assert.equal(JSON.stringify(result).includes(base.TURNKEY_SIGNING_API_PRIVATE_KEY), false);
  assert.equal(JSON.stringify(result).includes(base.LIVE_WORKER_OBSERVER_BEARER_TOKEN), false);
});

test("refuses either activation flag", () => {
  for (const key of ["LIVE_WORKER_SUBMISSION_CONNECTED",
    "LIVE_WORKER_AUTOMATIC_SUBMISSION_ENABLED"]) {
    const result = verifyDormantLiveWorkerConfig({ ...base, [key]: "true" });
    assert.equal(result.verified, false);
    assert.ok(result.failures.some((failure) => failure.includes("must-remain-disabled")));
  }
});

test("requires the private credential to resolve without printing it", () => {
  const result = verifyDormantLiveWorkerConfig({ ...base, TURNKEY_SIGNING_API_PRIVATE_KEY: "" });
  assert.equal(result.verified, false);
  assert.ok(result.failures.includes("live-worker-signing-private-key-required"));
  assert.equal(JSON.stringify(result).includes(base.LIVE_WORKER_OBSERVER_BEARER_TOKEN), false);
});
