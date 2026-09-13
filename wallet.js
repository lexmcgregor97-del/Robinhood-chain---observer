import { getAddress, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const ROBINHOOD_CHAIN_ID = 4663;
const ARM_PHRASE = "I_UNDERSTAND_LIVE_TRADING";

const parsePositiveBigInt = (value, name) => {
  try { const parsed = BigInt(value); if (parsed <= 0n) throw new Error(); return parsed; }
  catch { throw new Error(`${name} must be a positive integer in wei`); }
};

export function loadExecutionConfig(env = process.env) {
  const armed = env.LIVE_TRADING_ENABLED === ARM_PHRASE;
  const privateKey = env.WALLET_PRIVATE_KEY;
  if (!armed) return { armed: false, account: null, publicStatus: { armed: false, walletConfigured: Boolean(privateKey), address: null } };
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey || "")) throw new Error("WALLET_PRIVATE_KEY is missing or malformed");
  const account = privateKeyToAccount(privateKey);
  const routers = String(env.ALLOWED_ROUTER_ADDRESSES || "").split(",").map((item) => item.trim()).filter(Boolean);
  if (!routers.length || routers.some((address) => !isAddress(address))) throw new Error("ALLOWED_ROUTER_ADDRESSES must contain valid addresses");
  const policy = {
    maxTradeWei: parsePositiveBigInt(env.MAX_TRADE_WEI, "MAX_TRADE_WEI"),
    maxDailySpendWei: parsePositiveBigInt(env.MAX_DAILY_SPEND_WEI, "MAX_DAILY_SPEND_WEI"),
    maxGasWei: parsePositiveBigInt(env.MAX_GAS_WEI, "MAX_GAS_WEI"),
    maxSlippageBps: Number(env.MAX_SLIPPAGE_BPS),
    allowedRouters: new Set(routers.map(getAddress)),
  };
  if (!Number.isInteger(policy.maxSlippageBps) || policy.maxSlippageBps < 1 || policy.maxSlippageBps > 1000) throw new Error("MAX_SLIPPAGE_BPS must be an integer from 1 to 1000");
  return { armed: true, account, policy, publicStatus: { armed: true, walletConfigured: true, address: account.address } };
}

export function authorizeTransaction(config, intent) {
  const failures = [];
  if (!config.armed || !config.account || !config.policy) failures.push("wallet-disarmed");
  if (intent.chainId !== ROBINHOOD_CHAIN_ID) failures.push("wrong-chain");
  const to = isAddress(intent.to || "") ? getAddress(intent.to) : null;
  if (!to || !config.policy?.allowedRouters.has(to)) failures.push("router-not-allowed");
  const value = BigInt(intent.valueWei ?? 0), gas = BigInt(intent.estimatedGasWei ?? 0), spent = BigInt(intent.dailySpentWei ?? 0);
  if (config.policy && (value <= 0n || value > config.policy.maxTradeWei)) failures.push("trade-cap-exceeded");
  if (config.policy && spent + value > config.policy.maxDailySpendWei) failures.push("daily-cap-exceeded");
  if (config.policy && (gas <= 0n || gas > config.policy.maxGasWei)) failures.push("gas-cap-exceeded");
  if (config.policy && (!Number.isFinite(intent.slippageBps) || intent.slippageBps > config.policy.maxSlippageBps)) failures.push("slippage-cap-exceeded");
  if (!/^0x[0-9a-fA-F]{8,}$/.test(intent.data || "")) failures.push("missing-calldata");
  return { authorized: failures.length === 0, failures };
}
