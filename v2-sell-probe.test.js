import test from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionResult } from "viem";
import {
  ERC20_SELL_PROBE_ABI, isSellProbeReady, probeStateOverrideSupport, probeV2Sell,
  sellProbeConfigFromEnv,
} from "./v2-sell-probe.js";
import { V2_ROUTER_ABI } from "./router-calldata.js";

const holder = "0x1111111111111111111111111111111111111111";
const atlas = "0x7777777777777777777777777777777777777777";
const router = "0x2222222222222222222222222222222222222222";
const quote = "0x3333333333333333333333333333333333333333";
const base = "0x4444444444444444444444444444444444444444";
const pair = "0x5555555555555555555555555555555555555555";
const transactionHash = `0x${"ab".repeat(32)}`;
const pool = { address: pair, version: "v2", dex: "uniswap", token0: quote, token1: base };
const safety = {
  quoteToken: quote, baseToken: base, buyAmountOut: "1000",
  reserveQuote: "1000000", reserveToken: "1000000",
};
const lastSwap = { transactionHash, blockNumber: 990, direction: "token1-to-token0" };
const uint = (value) => `0x${BigInt(value).toString(16).padStart(64, "0")}`;

function successfulRpc(overrides = {}, calls = []) {
  return async (method, params) => {
    calls.push({ method, params });
    if (method === "eth_getTransactionByHash") return { from: holder, to: router };
    if (method === "eth_call" && params[0].to === base) {
      if (params[2]?.[base]?.stateDiff) {
        return Object.values(params[2][base].stateDiff)[0];
      }
      const selector = params[0].data.slice(0, 10);
      const balanceSelector = "0x70a08231";
      return selector === balanceSelector
        ? uint(overrides.balance ?? 10_000n) : uint(overrides.allowance ?? 10_000n);
    }
    if (method === "eth_call" && params[0].to === router) {
      return encodeFunctionResult({
        abi: V2_ROUTER_ABI, functionName: "swapExactTokensForTokens",
        result: [1_000n, 950n],
      });
    }
    throw new Error("unexpected-rpc");
  };
}

test("configuration reuses the verified V2 router allowlist", () => {
  const config = sellProbeConfigFromEnv({ PAPER_V2_ROUTER_ADDRESSES: router });
  assert.equal(config.configured, true);
  assert.deepEqual(config.allowedRouters, [router]);
  assert.equal(config.canaryBalanceSlot, 51);
  assert.equal(config.negativeCacheMs, 60 * 60_000);
  assert.equal(sellProbeConfigFromEnv({}).configured, false);
});

test("readiness survives candidate absence but not failure or expiry", () => {
  const now = 1_000_000;
  const config = { configured: true, maxAgeMs: 15 * 60_000 };
  const lastSuccessAt = new Date(now - 60_000).toISOString();
  assert.equal(isSellProbeReady({ passed: false, lastSuccessAt,
    failures: ["sell-probe-candidate-unavailable"] }, config, now), true);
  assert.equal(isSellProbeReady({ passed: false, lastSuccessAt,
    failures: ["sell-probe-self-simulation-failed"] }, config, now), false);
  assert.equal(isSellProbeReady({ passed: true,
    lastSuccessAt: new Date(now - config.maxAgeMs - 1).toISOString(), failures: [] },
  config, now), false);
});

test("one-call WETH canary proves provider state-override support", async () => {
  let calls = 0;
  const supported = await probeStateOverrideSupport({
    token: quote, walletAddress: atlas, balanceSlot: 3, now: 1_000,
    rpc: async (method, params) => {
      calls += 1;
      assert.equal(method, "eth_call");
      return Object.values(params[2][quote].stateDiff)[0];
    },
  });
  assert.equal(calls, 1);
  assert.equal(supported.supported, true);
  const unsupported = await probeStateOverrideSupport({
    token: quote, walletAddress: atlas, balanceSlot: 3,
    rpc: async () => { throw new Error("state override unsupported"); },
  });
  assert.equal(unsupported.supported, false);
  assert.deepEqual(unsupported.failures, ["sell-probe-state-override-unsupported"]);
});

test("simulates an exact bounded sell from a recent observed seller", async () => {
  const calls = [];
  const result = await probeV2Sell({
    pool, safety, lastSwap, latestBlock: 1_000, allowedRouters: [router],
    atlasWalletAddress: atlas, rpc: successfulRpc({}, calls), nowSeconds: 1_000,
  });
  assert.equal(result.passed, true, JSON.stringify(result));
  assert.equal(result.amountIn, "1000");
  assert.ok(BigInt(result.amountOutMin) > 0n);
  assert.equal("holder" in result, false);
  assert.equal("router" in result, false);
  assert.equal("transactionHash" in result, false);
  assert.equal(result.observedSellPassed, true);
  assert.equal(result.selfSimulationPassed, true);
  const selfCall = calls.find((call) => call.method === "eth_call"
    && call.params[0].to === router && call.params[0].from === atlas);
  assert.ok(selfCall?.params[2]?.[base]?.stateDiff);
  assert.equal(Object.keys(selfCall.params[2][base].stateDiff).length, 2);
});

test("fails closed for a buy-side observation or stale seller", async () => {
  const buy = await probeV2Sell({
    pool, safety, lastSwap: { ...lastSwap, direction: "token0-to-token1" },
    latestBlock: 1_000, allowedRouters: [router], atlasWalletAddress: atlas,
    rpc: successfulRpc(),
  });
  assert.ok(buy.failures.includes("sell-probe-observed-sell-required"));
  const stale = await probeV2Sell({
    pool, safety, lastSwap, latestBlock: 3_000, maxSwapAgeBlocks: 100,
    allowedRouters: [router], atlasWalletAddress: atlas, rpc: successfulRpc(),
  });
  assert.ok(stale.failures.includes("sell-probe-observed-sell-stale"));
});

test("requires the observed router but not the seller's post-sale balance", async () => {
  const foreign = await probeV2Sell({
    pool, safety, lastSwap, latestBlock: 1_000,
    allowedRouters: ["0x6666666666666666666666666666666666666666"],
    atlasWalletAddress: atlas, rpc: successfulRpc(),
  });
  assert.ok(foreign.failures.includes("sell-probe-observed-router-not-allowed"));
  const calls = [];
  const soldBalance = await probeV2Sell({
    pool, safety, lastSwap, latestBlock: 1_000, allowedRouters: [router],
    atlasWalletAddress: atlas,
    rpc: successfulRpc({ balance: 0n, allowance: 0n }, calls),
  });
  assert.equal(soldBalance.passed, true, JSON.stringify(soldBalance));
  assert.equal(soldBalance.observedSellPassed, true);
  assert.equal(calls.some((call) => call.method === "eth_call"
    && call.params[0].to === base && !call.params[2]), false);
});

test("an Atlas router revert never becomes sell evidence", async () => {
  const rpc = successfulRpc();
  const result = await probeV2Sell({
    pool, safety, lastSwap, latestBlock: 1_000, allowedRouters: [router],
    atlasWalletAddress: atlas,
    rpc: async (method, params) => {
      if (method === "eth_call" && params[0].to === router) throw new Error("execution reverted");
      return rpc(method, params);
    },
  });
  assert.equal(result.passed, false);
  assert.deepEqual(result.failures, ["sell-probe-self-simulation-failed"]);
});

test("a privileged observed seller cannot substitute for Atlas self-simulation", async () => {
  const rpc = successfulRpc();
  const result = await probeV2Sell({
    pool, safety, lastSwap, latestBlock: 1_000, allowedRouters: [router],
    atlasWalletAddress: atlas,
    rpc: async (method, params) => {
      if (method === "eth_call" && params[0].to === router
          && params[0].from === atlas) throw new Error("atlas-restricted");
      return rpc(method, params);
    },
  });
  assert.equal(result.passed, false);
  assert.equal(result.observedSellPassed, true);
  assert.equal(result.selfSimulationPassed, false);
  assert.deepEqual(result.failures, ["sell-probe-self-simulation-failed"]);
});

test("Atlas wallet and bounded storage discovery are mandatory", async () => {
  const missingWallet = await probeV2Sell({
    pool, safety, lastSwap, latestBlock: 1_000, allowedRouters: [router],
    rpc: successfulRpc(),
  });
  assert.deepEqual(missingWallet.failures, ["sell-probe-atlas-wallet-required"]);
  const noSlots = await probeV2Sell({
    pool: { ...pool, token1: "0x8888888888888888888888888888888888888888" },
    safety: { ...safety, baseToken: "0x8888888888888888888888888888888888888888" },
    lastSwap, latestBlock: 1_000, allowedRouters: [router], atlasWalletAddress: atlas,
    maxStorageSlot: 1,
    rpc: async (method, params) => {
      if (method === "eth_getTransactionByHash") return { from: holder, to: router };
      if (method === "eth_call" && params[0].to === router) {
        return encodeFunctionResult({ abi: V2_ROUTER_ABI,
          functionName: "swapExactTokensForTokens", result: [1_000n, 950n] });
      }
      return uint(10_000n);
    },
  });
  assert.equal(noSlots.observedSellPassed, true);
  assert.deepEqual(noSlots.failures, ["sell-probe-balance-slot-unresolved"]);
});

test("negative token-layout discovery is cached", async () => {
  const unusualBase = "0x9999999999999999999999999999999999999999";
  let discoveryCalls = 0;
  const rpc = async (method, params) => {
    if (method === "eth_getTransactionByHash") return { from: holder, to: router };
    if (method === "eth_call" && params[0].to === unusualBase) {
      if (params[2]) discoveryCalls += 1;
      return uint(10_000n);
    }
    if (method === "eth_call" && params[0].to === router) {
      return encodeFunctionResult({ abi: V2_ROUTER_ABI,
        functionName: "swapExactTokensForTokens", result: [1_000n, 950n] });
    }
    throw new Error("unexpected-rpc");
  };
  const input = {
    pool: { ...pool, token1: unusualBase },
    safety: { ...safety, baseToken: unusualBase },
    lastSwap, latestBlock: 1_000, allowedRouters: [router], atlasWalletAddress: atlas,
    maxStorageSlot: 2, negativeCacheMs: 60_000, rpc,
  };
  const first = await probeV2Sell(input);
  assert.deepEqual(first.failures, ["sell-probe-balance-slot-unresolved"]);
  assert.equal(discoveryCalls, 3);
  const second = await probeV2Sell(input);
  assert.deepEqual(second.failures, ["sell-probe-balance-slot-unresolved"]);
  assert.equal(discoveryCalls, 3);
});

test("ERC20 probe ABI remains limited to read-only balance and allowance", () => {
  assert.deepEqual(ERC20_SELL_PROBE_ABI.map((entry) => entry.name), ["balanceOf", "allowance"]);
  assert.ok(ERC20_SELL_PROBE_ABI.every((entry) => entry.stateMutability === "view"));
});
