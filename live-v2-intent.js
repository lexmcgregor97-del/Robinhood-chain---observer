import { createHash } from "node:crypto";
import { encodeFunctionData, getAddress, isAddressEqual } from "viem";
import { normalizeExecutionIntent } from "./execution-intent.js";
import { V2_ROUTER_ABI } from "./router-calldata.js";
import { quoteV2 } from "./v2-simulator.js";

const UINT = /^(0|[1-9][0-9]*)$/;
const lower = (value) => String(value || "").toLowerCase();

function uint(value, failure) {
  const text = String(value ?? "");
  if (!UINT.test(text)) throw new Error(failure);
  return BigInt(text);
}

function address(value, failure) {
  try { return getAddress(value); } catch { throw new Error(failure); }
}

function intentId(fields) {
  const digest = createHash("sha256").update(JSON.stringify(fields)).digest("hex");
  return `live:v2:buy:${digest.slice(0, 48)}`;
}

export function buildLiveV2BuyIntent({
  candidate,
  snapshot,
  config,
  amountInWei,
  slippageBps,
  now = Date.now(),
  deadlineSeconds = 60,
} = {}) {
  if (candidate?.version !== "v2") throw new Error("live-candidate-v2-required");
  const pool = address(candidate.address, "live-candidate-pool-invalid");
  const hintedToken0 = address(candidate.token0, "live-candidate-token-invalid");
  const hintedToken1 = address(candidate.token1, "live-candidate-token-invalid");
  const router = address(candidate.router, "live-candidate-router-invalid");
  const wallet = address(config?.walletAddress, "live-wallet-invalid");
  const weth = address(config?.wethAddress, "live-weth-invalid");
  if (!(config?.allowedRouters || []).some((allowed) => isAddressEqual(allowed, router))) {
    throw new Error("live-router-not-allowed");
  }
  if (!snapshot || !isAddressEqual(snapshot.poolAddress, pool)
      || !isAddressEqual(snapshot.token0, hintedToken0)
      || !isAddressEqual(snapshot.token1, hintedToken1)) {
    throw new Error("live-candidate-chain-mismatch");
  }
  const quoteIsToken0 = isAddressEqual(snapshot.token0, weth);
  const quoteIsToken1 = isAddressEqual(snapshot.token1, weth);
  if (quoteIsToken0 === quoteIsToken1) throw new Error("live-weth-pair-required");
  const baseToken = quoteIsToken0 ? snapshot.token1 : snapshot.token0;
  const reserveIn = uint(quoteIsToken0 ? snapshot.reserve0 : snapshot.reserve1,
    "live-reserve-invalid");
  const reserveOut = uint(quoteIsToken0 ? snapshot.reserve1 : snapshot.reserve0,
    "live-reserve-invalid");
  const amountIn = uint(amountInWei, "live-amount-in-invalid");
  if (amountIn <= 0n || amountIn > uint(config?.maxPerTransactionWei,
    "live-transaction-cap-invalid")) throw new Error("live-amount-in-limit");
  const bps = Number(slippageBps);
  if (!Number.isSafeInteger(bps) || bps <= 0 || bps > 2_000) {
    throw new Error("live-slippage-invalid");
  }
  const ttl = Number(deadlineSeconds);
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > 60) {
    throw new Error("live-deadline-invalid");
  }
  const quoted = quoteV2({ reserveIn, reserveOut, amountIn,
    feeBps: candidate.dex === "pancakeswap" ? 25 : 30 });
  const amountOutMin = quoted.amountOut * BigInt(10_000 - bps) / 10_000n;
  if (amountOutMin <= 0n) throw new Error("live-minimum-output-invalid");
  const nowSeconds = Math.floor(now / 1_000);
  const deadline = nowSeconds + ttl;
  const path = [weth, getAddress(baseToken)];
  const data = encodeFunctionData({ abi: V2_ROUTER_ABI,
    functionName: "swapExactTokensForTokens",
    args: [amountIn, amountOutMin, path, wallet, BigInt(deadline)] });
  const blockNumber = Number(snapshot.blockNumber);
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) {
    throw new Error("live-snapshot-block-invalid");
  }
  const identity = Object.freeze({ chainId: Number(config.chainId), pool: lower(pool),
    router: lower(router), blockNumber, amountIn: amountIn.toString(),
    amountOutMin: amountOutMin.toString(), baseToken: lower(baseToken) });
  return normalizeExecutionIntent({ id: intentId(identity), purpose: "live-v2-buy",
    chainId: config.chainId, from: wallet, to: router, valueWei: "0",
    spendAsset: weth, spendAmount: amountIn.toString(), data,
    expiresAt: now + ttl * 1_000 });
}

