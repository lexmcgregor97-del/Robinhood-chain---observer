import test from "node:test";
import assert from "node:assert/strict";
import { authorizeTransaction, loadExecutionConfig } from "./wallet.js";

const router = "0x0000000000000000000000000000000000000001";
const armedEnv = { LIVE_TRADING_ENABLED: "I_UNDERSTAND_LIVE_TRADING", WALLET_PRIVATE_KEY: `0x${"11".repeat(32)}`,
  ALLOWED_ROUTER_ADDRESSES: router, MAX_TRADE_WEI: "100", MAX_DAILY_SPEND_WEI: "300", MAX_GAS_WEI: "10", MAX_SLIPPAGE_BPS: "100" };

test("stays disarmed without the exact arm phrase", () => {
  const config = loadExecutionConfig({ WALLET_PRIVATE_KEY: armedEnv.WALLET_PRIVATE_KEY });
  assert.deepEqual(config.publicStatus, { armed: false, walletConfigured: true, address: null });
  assert.equal(JSON.stringify(config.publicStatus).includes(armedEnv.WALLET_PRIVATE_KEY), false);
});

test("loads a dedicated account without exposing its key", () => {
  const config = loadExecutionConfig(armedEnv);
  assert.equal(config.armed, true);
  assert.match(config.publicStatus.address, /^0x[0-9A-Fa-f]{40}$/);
  assert.equal(JSON.stringify(config.publicStatus).includes(armedEnv.WALLET_PRIVATE_KEY), false);
});

test("authorizes only bounded allowlisted intents", () => {
  const config = loadExecutionConfig(armedEnv);
  assert.deepEqual(authorizeTransaction(config, { chainId: 4663, to: router, valueWei: 50n, dailySpentWei: 100n,
    estimatedGasWei: 5n, slippageBps: 50, data: "0x12345678" }), { authorized: true, failures: [] });
});

test("blocks wrong-chain, unknown-router, and over-cap intents", () => {
  const config = loadExecutionConfig(armedEnv);
  const result = authorizeTransaction(config, { chainId: 1, to: "0x0000000000000000000000000000000000000002",
    valueWei: 101n, dailySpentWei: 250n, estimatedGasWei: 11n, slippageBps: 101, data: "0x" });
  assert.deepEqual(result.failures, ["wrong-chain", "router-not-allowed", "trade-cap-exceeded", "daily-cap-exceeded",
    "gas-cap-exceeded", "slippage-cap-exceeded", "missing-calldata"]);
});
