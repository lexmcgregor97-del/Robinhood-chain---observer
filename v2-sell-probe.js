import {
  decodeFunctionResult, encodeFunctionData, getAddress, isAddress,
} from "viem";
import { validateV2RouterCalldata, V2_ROUTER_ABI } from "./router-calldata.js";
import { quoteV2 } from "./v2-simulator.js";

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const UINT_RESULT = /^0x[0-9a-fA-F]{1,64}$/;

export const ERC20_SELL_PROBE_ABI = Object.freeze([
  {
    type: "function", name: "balanceOf", stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
  },
  {
    type: "function", name: "allowance", stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    outputs: [{ name: "amount", type: "uint256" }],
  },
]);

const lower = (value) => String(value || "").toLowerCase();
const positiveInteger = (value, fallback) => {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

function uintResult(value, failure) {
  if (!UINT_RESULT.test(String(value || ""))) throw new Error(failure);
  return BigInt(value);
}

export function sellProbeConfigFromEnv(env = process.env) {
  const failures = [];
  const allowedRouters = [...new Set(String(env.PAPER_V2_ROUTER_ADDRESSES || "")
    .split(/[\s,]+/).filter(Boolean).map(lower))];
  if (!allowedRouters.length || allowedRouters.some((address) => !isAddress(address))) {
    failures.push("sell-probe-router-allowlist-required");
  }
  const intervalMs = positiveInteger(env.SELL_PROBE_INTERVAL_MS, 5 * 60_000);
  const maxAgeMs = positiveInteger(env.SELL_PROBE_MAX_AGE_MS, 15 * 60_000);
  const maxSwapAgeBlocks = positiveInteger(env.SELL_PROBE_MAX_SWAP_AGE_BLOCKS, 1_200);
  const maxSlippageBps = positiveInteger(env.SELL_PROBE_MAX_SLIPPAGE_BPS, 500);
  if (!intervalMs || intervalMs < 60_000) failures.push("sell-probe-interval-invalid");
  if (!maxAgeMs || maxAgeMs < intervalMs) failures.push("sell-probe-max-age-invalid");
  if (!maxSwapAgeBlocks) failures.push("sell-probe-swap-age-invalid");
  if (!maxSlippageBps || maxSlippageBps > 2_000) failures.push("sell-probe-slippage-invalid");
  return Object.freeze({
    configured: failures.length === 0,
    allowedRouters: Object.freeze(allowedRouters),
    intervalMs, maxAgeMs, maxSwapAgeBlocks, maxSlippageBps,
    failures: Object.freeze(failures),
  });
}

export async function probeV2Sell({
  pool, safety, lastSwap, latestBlock, allowedRouters, rpc,
  maxSwapAgeBlocks = 1_200, maxSlippageBps = 500,
  nowSeconds = Math.floor(Date.now() / 1_000),
}) {
  const checkedAt = new Date(nowSeconds * 1_000).toISOString();
  const fail = (...failures) => Object.freeze({
    passed: false, checkedAt, method: "observed-holder-router-eth-call",
    failures: [...new Set(failures)],
  });
  if (pool?.version !== "v2") return fail("sell-probe-v2-required");
  if (typeof rpc !== "function") return fail("sell-probe-rpc-required");
  const baseToken = lower(safety?.baseToken);
  const quoteToken = lower(safety?.quoteToken);
  if (![pool?.address, pool?.token0, pool?.token1, baseToken, quoteToken]
    .every((address) => isAddress(address))) return fail("sell-probe-address-invalid");
  const routers = [...new Set((allowedRouters || []).map(lower))];
  if (!routers.length || routers.some((address) => !isAddress(address))) {
    return fail("sell-probe-router-allowlist-required");
  }
  if (!TX_HASH.test(String(lastSwap?.transactionHash || ""))) {
    return fail("sell-probe-transaction-required");
  }
  const quoteIsToken0 = lower(pool.token0) === quoteToken;
  const expectedDirection = quoteIsToken0 ? "token1-to-token0" : "token0-to-token1";
  if (lastSwap?.direction !== expectedDirection) return fail("sell-probe-observed-sell-required");
  const blockAge = Number(latestBlock) - Number(lastSwap.blockNumber);
  if (!Number.isFinite(blockAge) || blockAge < 0 || blockAge > Number(maxSwapAgeBlocks)) {
    return fail("sell-probe-observed-sell-stale");
  }
  let amountIn;
  let expectedOut;
  try {
    amountIn = BigInt(safety?.buyAmountOut);
    expectedOut = quoteV2({
      reserveIn: BigInt(safety?.reserveToken),
      reserveOut: BigInt(safety?.reserveQuote),
      amountIn,
      feeBps: pool.dex === "pancakeswap" ? 25 : 30,
    }).amountOut;
  } catch {
    return fail("sell-probe-quote-invalid");
  }
  const slippageBps = Number(maxSlippageBps);
  if (!Number.isInteger(slippageBps) || slippageBps <= 0 || slippageBps > 2_000) {
    return fail("sell-probe-slippage-invalid");
  }
  const amountOutMin = expectedOut * BigInt(10_000 - slippageBps) / 10_000n;
  if (amountOutMin <= 0n) return fail("sell-probe-minimum-output-invalid");

  try {
    const transaction = await rpc("eth_getTransactionByHash", [lastSwap.transactionHash]);
    const holder = lower(transaction?.from);
    const router = lower(transaction?.to);
    if (!isAddress(holder)) return fail("sell-probe-holder-unavailable");
    if (!routers.includes(router)) return fail("sell-probe-observed-router-not-allowed");
    const balanceData = encodeFunctionData({
      abi: ERC20_SELL_PROBE_ABI, functionName: "balanceOf", args: [getAddress(holder)],
    });
    const allowanceData = encodeFunctionData({
      abi: ERC20_SELL_PROBE_ABI, functionName: "allowance",
      args: [getAddress(holder), getAddress(router)],
    });
    const [balanceResult, allowanceResult] = await Promise.all([
      rpc("eth_call", [{ to: baseToken, data: balanceData }, "latest"]),
      rpc("eth_call", [{ to: baseToken, data: allowanceData }, "latest"]),
    ]);
    if (uintResult(balanceResult, "sell-probe-balance-invalid") < amountIn) {
      return fail("sell-probe-holder-balance-insufficient");
    }
    if (uintResult(allowanceResult, "sell-probe-allowance-invalid") < amountIn) {
      return fail("sell-probe-holder-allowance-insufficient");
    }
    const deadline = nowSeconds + 60;
    const path = [getAddress(baseToken), getAddress(quoteToken)];
    const data = encodeFunctionData({
      abi: V2_ROUTER_ABI,
      functionName: "swapExactTokensForTokens",
      args: [amountIn, amountOutMin, path, getAddress(holder), BigInt(deadline)],
    });
    const intent = {
      valueWei: "0", spendAsset: baseToken, spendAmount: amountIn.toString(), data,
    };
    const validation = validateV2RouterCalldata(intent, {
      walletAddress: holder, allowedPaths: [path], maxRouterDeadlineSeconds: 60,
    }, { nowSeconds });
    if (!validation.approved) return fail("sell-probe-calldata-rejected");
    const result = await rpc("eth_call", [{ from: holder, to: router, data }, "latest"]);
    const amounts = decodeFunctionResult({
      abi: V2_ROUTER_ABI, functionName: "swapExactTokensForTokens", data: result,
    });
    if (!Array.isArray(amounts) || amounts.length < 2
        || BigInt(amounts[0]) !== amountIn || BigInt(amounts.at(-1)) < amountOutMin) {
      return fail("sell-probe-router-output-invalid");
    }
    return Object.freeze({
      passed: true, checkedAt, method: "observed-holder-router-eth-call",
      amountIn: amountIn.toString(), amountOutMin: amountOutMin.toString(),
      failures: [],
    });
  } catch {
    return fail("sell-probe-rpc-simulation-failed");
  }
}

