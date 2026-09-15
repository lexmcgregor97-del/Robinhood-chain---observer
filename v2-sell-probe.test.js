import test from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionResult } from "viem";
import {
  ERC20_SELL_PROBE_ABI, probeV2Sell, sellProbeConfigFromEnv,
} from "./v2-sell-probe.js";
import { V2_ROUTER_ABI } from "./router-calldata.js";

const holder = "0x1111111111111111111111111111111111111111";
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

function successfulRpc(overrides = {}) {
  return async (method, params) => {
    if (method === "eth_getTransactionByHash") return { from: holder, to: router };
    if (method === "eth_call" && params[0].to === base) {
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
  assert.equal(sellProbeConfigFromEnv({}).configured, false);
});

test("simulates an exact bounded sell from a recent observed seller", async () => {
  const result = await probeV2Sell({
    pool, safety, lastSwap, latestBlock: 1_000, allowedRouters: [router],
    rpc: successfulRpc(), nowSeconds: 1_000,
  });
  assert.equal(result.passed, true, JSON.stringify(result));
  assert.equal(result.amountIn, "1000");
  assert.ok(BigInt(result.amountOutMin) > 0n);
  assert.equal("holder" in result, false);
  assert.equal("router" in result, false);
  assert.equal("transactionHash" in result, false);
});

test("fails closed for a buy-side observation or stale seller", async () => {
  const buy = await probeV2Sell({
    pool, safety, lastSwap: { ...lastSwap, direction: "token0-to-token1" },
    latestBlock: 1_000, allowedRouters: [router], rpc: successfulRpc(),
  });
  assert.ok(buy.failures.includes("sell-probe-observed-sell-required"));
  const stale = await probeV2Sell({
    pool, safety, lastSwap, latestBlock: 3_000, maxSwapAgeBlocks: 100,
    allowedRouters: [router], rpc: successfulRpc(),
  });
  assert.ok(stale.failures.includes("sell-probe-observed-sell-stale"));
});

test("requires the observed router, balance, and allowance", async () => {
  const foreign = await probeV2Sell({
    pool, safety, lastSwap, latestBlock: 1_000,
    allowedRouters: ["0x6666666666666666666666666666666666666666"],
    rpc: successfulRpc(),
  });
  assert.ok(foreign.failures.includes("sell-probe-observed-router-not-allowed"));
  const balance = await probeV2Sell({
    pool, safety, lastSwap, latestBlock: 1_000, allowedRouters: [router],
    rpc: successfulRpc({ balance: 999n }),
  });
  assert.ok(balance.failures.includes("sell-probe-holder-balance-insufficient"));
  const allowance = await probeV2Sell({
    pool, safety, lastSwap, latestBlock: 1_000, allowedRouters: [router],
    rpc: successfulRpc({ allowance: 999n }),
  });
  assert.ok(allowance.failures.includes("sell-probe-holder-allowance-insufficient"));
});

test("a router revert never becomes sell evidence", async () => {
  const rpc = successfulRpc();
  const result = await probeV2Sell({
    pool, safety, lastSwap, latestBlock: 1_000, allowedRouters: [router],
    rpc: async (method, params) => {
      if (method === "eth_call" && params[0].to === router) throw new Error("execution reverted");
      return rpc(method, params);
    },
  });
  assert.equal(result.passed, false);
  assert.deepEqual(result.failures, ["sell-probe-rpc-simulation-failed"]);
});

test("ERC20 probe ABI remains limited to read-only balance and allowance", () => {
  assert.deepEqual(ERC20_SELL_PROBE_ABI.map((entry) => entry.name), ["balanceOf", "allowance"]);
  assert.ok(ERC20_SELL_PROBE_ABI.every((entry) => entry.stateMutability === "view"));
});
