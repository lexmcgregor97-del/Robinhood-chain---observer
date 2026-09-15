import test from "node:test";
import assert from "node:assert/strict";
import { liveWorkerConfigFromEnv } from "./live-worker-config.js";

const WALLET = "0x1111111111111111111111111111111111111111";
const ROUTER = "0x2222222222222222222222222222222222222222";
const UUIDS = [1, 2, 3, 4].map((n) => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`);
const base = { ATLAS_EXECUTION_MODE: "MICRO_MAINNET", MICRO_MAINNET_ENABLED: "true",
  TURNKEY_SIGNING_ORGANIZATION_ID: UUIDS[0], TURNKEY_ORGANIZATION_ID: UUIDS[0],
  TURNKEY_SIGNING_WALLET_ADDRESS: WALLET, TURNKEY_WALLET_ADDRESS: WALLET,
  TURNKEY_SIGNING_BUY_POLICY_ID: UUIDS[1], TURNKEY_SIGNING_SELL_POLICY_ID: UUIDS[2],
  TURNKEY_SIGNING_APPROVAL_POLICY_ID: UUIDS[3],
  TURNKEY_SIGNING_API_PUBLIC_KEY: `02${"1".repeat(64)}`,
  TURNKEY_API_PUBLIC_KEY: `02${"2".repeat(64)}`,
  MICRO_MAINNET_V2_ROUTERS: ROUTER, MICRO_MAINNET_MAX_WETH_PER_TX_WEI: "100",
  MICRO_MAINNET_MAX_WETH_DAILY_WEI: "200", MICRO_MAINNET_MAX_GAS: "400000",
  MICRO_MAINNET_MAX_FEE_PER_GAS_WEI: "2000000000",
  MICRO_MAINNET_CONFIRMATION: `ENABLE_ATLAS_MICRO_MAINNET:4663:${WALLET}`,
  ATLAS_OBSERVER_URL: "https://atlas.example", LIVE_WORKER_STATE_FILE: "/data/live.json",
  LIVE_WORKER_EVIDENCE_FILE: "/data/live.jsonl", LIVE_WORKER_V2_ROUTER_ADDRESS: ROUTER,
  LIVE_WORKER_BUY_AMOUNT_WEI: "10", LIVE_WORKER_MAX_ALLOWANCE_WEI: "100",
  LIVE_WORKER_MIN_NATIVE_BALANCE_WEI: "1" };

test("stays disconnected by default even with complete execution configuration", () => {
  const result = liveWorkerConfigFromEnv(base);
  assert.equal(result.configured, true);
  assert.equal(result.connected, false);
  assert.equal(result.automatic, false);
});

test("requires an independent exact worker ceremony before connection", () => {
  const wrong = liveWorkerConfigFromEnv({ ...base, LIVE_WORKER_SUBMISSION_CONNECTED: "true" });
  assert.ok(wrong.failures.includes("live-worker-confirmation-mismatch"));
  const exact = liveWorkerConfigFromEnv({ ...base, LIVE_WORKER_SUBMISSION_CONNECTED: "true",
    LIVE_WORKER_CONFIRMATION: `CONNECT_ATLAS_PRIVATE_WORKER:4663:${WALLET}` });
  assert.equal(exact.configured, true);
  assert.equal(exact.connected, true);
});

test("refuses allowance wider than the daily loss boundary", () => {
  const result = liveWorkerConfigFromEnv({ ...base, LIVE_WORKER_MAX_ALLOWANCE_WEI: "201" });
  assert.ok(result.failures.includes("live-worker-allowance-exceeds-daily-cap"));
});
