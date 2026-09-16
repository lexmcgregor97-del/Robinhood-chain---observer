import {
  decodeFunctionResult, encodeAbiParameters, encodeFunctionData, getAddress, isAddress,
  keccak256,
} from "viem";
import { validateV2RouterCalldata, V2_ROUTER_ABI } from "./router-calldata.js";
import { quoteV2 } from "./v2-simulator.js";

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const UINT_RESULT = /^0x[0-9a-fA-F]{1,64}$/;
const BALANCE_SENTINEL = (1n << 255n) + 0x41544c4153n;
const ALLOWANCE_SENTINEL = (1n << 254n) + 0x41544c4153n;
const storageSlotCache = new Map();

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
const nonNegativeInteger = (value, fallback) => {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
};

const uintWord = (value) => `0x${BigInt(value).toString(16).padStart(64, "0")}`;

function mappingSlot(address, slot) {
  return keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    [getAddress(address), BigInt(slot)],
  ));
}

function nestedMappingSlot(owner, spender, slot) {
  const ownerSlot = mappingSlot(owner, slot);
  return keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "bytes32" }],
    [getAddress(spender), ownerSlot],
  ));
}

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
  const maxStorageSlot = positiveInteger(env.SELL_PROBE_MAX_STORAGE_SLOT, 24);
  const negativeCacheMs = positiveInteger(env.SELL_PROBE_NEGATIVE_CACHE_MS, 60 * 60_000);
  const canaryBalanceSlot = nonNegativeInteger(env.SELL_PROBE_CANARY_BALANCE_SLOT, 51);
  if (!intervalMs || intervalMs < 60_000) failures.push("sell-probe-interval-invalid");
  if (!maxAgeMs || maxAgeMs < intervalMs) failures.push("sell-probe-max-age-invalid");
  if (!maxSwapAgeBlocks) failures.push("sell-probe-swap-age-invalid");
  if (!maxSlippageBps || maxSlippageBps > 2_000) failures.push("sell-probe-slippage-invalid");
  if (!maxStorageSlot || maxStorageSlot > 256) failures.push("sell-probe-storage-range-invalid");
  if (!negativeCacheMs || negativeCacheMs < intervalMs) {
    failures.push("sell-probe-negative-cache-invalid");
  }
  if (canaryBalanceSlot === null || canaryBalanceSlot > 256) {
    failures.push("sell-probe-canary-slot-invalid");
  }
  return Object.freeze({
    configured: failures.length === 0,
    allowedRouters: Object.freeze(allowedRouters),
    intervalMs, maxAgeMs, maxSwapAgeBlocks, maxSlippageBps, maxStorageSlot,
    negativeCacheMs, canaryBalanceSlot,
    failures: Object.freeze(failures),
  });
}

export function isSellProbeReady(status, config, now = Date.now()) {
  if (config?.configured !== true) return false;
  const checkedAt = Date.parse(status?.lastSuccessAt || "");
  const maxAgeMs = Number(config?.maxAgeMs);
  if (!Number.isFinite(checkedAt) || !Number.isFinite(maxAgeMs)
      || maxAgeMs <= 0 || now < checkedAt || now - checkedAt > maxAgeMs) return false;
  if (status?.passed === true) return true;
  return Array.isArray(status?.failures)
    && status.failures.length === 1
    && status.failures[0] === "sell-probe-candidate-unavailable";
}

export async function probeStateOverrideSupport({
  token, walletAddress, balanceSlot = 51, rpc,
  now = Date.now(),
}) {
  const checkedAt = new Date(now).toISOString();
  const fail = (failure) => Object.freeze({
    checked: true, supported: false, checkedAt, failures: [failure],
  });
  const normalizedToken = lower(token);
  const wallet = lower(walletAddress);
  if (!isAddress(normalizedToken) || !isAddress(wallet)) {
    return fail("sell-probe-canary-address-invalid");
  }
  if (!Number.isInteger(Number(balanceSlot)) || Number(balanceSlot) < 0
      || Number(balanceSlot) > 256) return fail("sell-probe-canary-slot-invalid");
  if (typeof rpc !== "function") return fail("sell-probe-rpc-required");
  const callData = encodeFunctionData({
    abi: ERC20_SELL_PROBE_ABI, functionName: "balanceOf", args: [getAddress(wallet)],
  });
  const key = mappingSlot(wallet, Number(balanceSlot));
  try {
    const result = await rpc("eth_call", [
      { to: normalizedToken, data: callData }, "latest",
      { [normalizedToken]: { stateDiff: { [key]: uintWord(BALANCE_SENTINEL) } } },
    ]);
    if (uintResult(result, "sell-probe-canary-result-invalid") !== BALANCE_SENTINEL) {
      return fail("sell-probe-state-override-unsupported");
    }
    return Object.freeze({ checked: true, supported: true, checkedAt, failures: [] });
  } catch {
    return fail("sell-probe-state-override-unsupported");
  }
}

async function discoverStorageSlot({
  token, callData, addressForSlot, spender = null, sentinel, maxStorageSlot, rpc,
}) {
  for (let slot = 0; slot <= maxStorageSlot; slot += 1) {
    const key = spender
      ? nestedMappingSlot(addressForSlot, spender, slot)
      : mappingSlot(addressForSlot, slot);
    try {
      const result = await rpc("eth_call", [
        { to: token, data: callData }, "latest",
        { [token]: { stateDiff: { [key]: uintWord(sentinel) } } },
      ]);
      if (uintResult(result, "sell-probe-storage-result-invalid") === sentinel) {
        return { slot, key };
      }
    } catch {
      // A candidate slot can fail on unusual token layouts. Continue searching;
      // exhaustion remains fail-closed and is reported without provider text.
    }
  }
  return null;
}

function routerSellCall({ wallet, router, baseToken, quoteToken, amountIn,
  amountOutMin, nowSeconds }) {
  const deadline = nowSeconds + 60;
  const path = [getAddress(baseToken), getAddress(quoteToken)];
  const data = encodeFunctionData({
    abi: V2_ROUTER_ABI,
    functionName: "swapExactTokensForTokens",
    args: [amountIn, amountOutMin, path, getAddress(wallet), BigInt(deadline)],
  });
  const intent = {
    valueWei: "0", spendAsset: baseToken, spendAmount: amountIn.toString(), data,
  };
  const validation = validateV2RouterCalldata(intent, {
    walletAddress: wallet, allowedPaths: [path], maxRouterDeadlineSeconds: 60,
  }, { nowSeconds });
  return { data, deadline, intent, path, router, validation };
}

function validRouterResult(result, amountIn, amountOutMin) {
  const amounts = decodeFunctionResult({
    abi: V2_ROUTER_ABI, functionName: "swapExactTokensForTokens", data: result,
  });
  return Array.isArray(amounts) && amounts.length >= 2
    && BigInt(amounts[0]) === amountIn && BigInt(amounts.at(-1)) >= amountOutMin;
}

export async function probeV2Sell({
  pool, safety, lastSwap, latestBlock, allowedRouters, rpc,
  maxSwapAgeBlocks = 1_200, maxSlippageBps = 500,
  atlasWalletAddress, maxStorageSlot = 24, negativeCacheMs = 60 * 60_000,
  nowSeconds = Math.floor(Date.now() / 1_000),
}) {
  const checkedAt = new Date(nowSeconds * 1_000).toISOString();
  const fail = (...failures) => Object.freeze({
    passed: false, checkedAt,
    method: "observed-sell-and-atlas-state-override-eth-call",
    observedSellPassed: false, selfSimulationPassed: false,
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
  const atlasWallet = lower(atlasWalletAddress);
  if (!isAddress(atlasWallet)) return fail("sell-probe-atlas-wallet-required");
  if (!Number.isInteger(Number(maxStorageSlot)) || Number(maxStorageSlot) < 1
      || Number(maxStorageSlot) > 256) return fail("sell-probe-storage-range-invalid");
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

    const atlasBalanceData = encodeFunctionData({
      abi: ERC20_SELL_PROBE_ABI, functionName: "balanceOf", args: [getAddress(atlasWallet)],
    });
    const atlasAllowanceData = encodeFunctionData({
      abi: ERC20_SELL_PROBE_ABI, functionName: "allowance",
      args: [getAddress(atlasWallet), getAddress(router)],
    });
    let slots = storageSlotCache.get(baseToken);
    if (slots?.failure && slots.expiresAt > Date.now()) {
      return Object.freeze({ ...fail(slots.failure), observedSellPassed: true });
    }
    if (slots?.failure) {
      storageSlotCache.delete(baseToken);
      slots = null;
    }
    if (!slots) {
      const balance = await discoverStorageSlot({ token: baseToken, callData: atlasBalanceData,
        addressForSlot: atlasWallet, sentinel: BALANCE_SENTINEL,
        maxStorageSlot: Number(maxStorageSlot), rpc });
      if (!balance) {
        storageSlotCache.set(baseToken, { failure: "sell-probe-balance-slot-unresolved",
          expiresAt: Date.now() + Number(negativeCacheMs) });
        return Object.freeze({ ...fail("sell-probe-balance-slot-unresolved"),
          observedSellPassed: true });
      }
      const allowance = await discoverStorageSlot({ token: baseToken, callData: atlasAllowanceData,
        addressForSlot: atlasWallet, spender: router, sentinel: ALLOWANCE_SENTINEL,
        maxStorageSlot: Number(maxStorageSlot), rpc });
      if (!allowance) {
        storageSlotCache.set(baseToken, { failure: "sell-probe-allowance-slot-unresolved",
          expiresAt: Date.now() + Number(negativeCacheMs) });
        return Object.freeze({ ...fail("sell-probe-allowance-slot-unresolved"),
          observedSellPassed: true });
      }
      slots = { balanceSlot: balance.slot, allowanceSlot: allowance.slot };
      storageSlotCache.set(baseToken, slots);
    }
    const balanceKey = mappingSlot(atlasWallet, slots.balanceSlot);
    const allowanceKey = nestedMappingSlot(atlasWallet, router, slots.allowanceSlot);
    const atlasCall = routerSellCall({ wallet: atlasWallet, router, baseToken, quoteToken,
      amountIn, amountOutMin, nowSeconds });
    if (!atlasCall.validation.approved) return Object.freeze({
      ...fail("sell-probe-self-calldata-rejected"), observedSellPassed: true,
    });
    const stateOverride = { [baseToken]: { stateDiff: {
      [balanceKey]: uintWord(amountIn), [allowanceKey]: uintWord(amountIn),
    } } };
    let selfResult;
    try {
      selfResult = await rpc("eth_call", [{ from: atlasWallet, to: router,
        data: atlasCall.data }, "latest", stateOverride]);
    } catch {
      return Object.freeze({ ...fail("sell-probe-self-simulation-failed"),
        observedSellPassed: true });
    }
    if (!validRouterResult(selfResult, amountIn, amountOutMin)) {
      return Object.freeze({ ...fail("sell-probe-self-router-output-invalid"),
        observedSellPassed: true });
    }
    return Object.freeze({
      passed: true, checkedAt,
      method: "observed-sell-and-atlas-state-override-eth-call",
      observedSellPassed: true, selfSimulationPassed: true,
      amountIn: amountIn.toString(), amountOutMin: amountOutMin.toString(),
      failures: [],
    });
  } catch {
    return fail("sell-probe-rpc-simulation-failed");
  }
}
