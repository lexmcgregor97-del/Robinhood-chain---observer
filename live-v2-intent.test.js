import test from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData } from "viem";
import { buildLiveV2BuyIntent, buildLiveV2SellIntent } from "./live-v2-intent.js";
import { V2_ROUTER_ABI } from "./router-calldata.js";

const WETH = "0x0000000000000000000000000000000000000001";
const TOKEN = "0x0000000000000000000000000000000000000002";
const POOL = "0x0000000000000000000000000000000000000003";
const ROUTER = "0x0000000000000000000000000000000000000004";
const WALLET = "0x0000000000000000000000000000000000000005";
const config = { chainId: 4663, walletAddress: WALLET, wethAddress: WETH,
  allowedRouters: [ROUTER], maxPerTransactionWei: "1000" };
const candidate = { version: "v2", dex: "uniswap", address: POOL,
  token0: WETH, token1: TOKEN, router: ROUTER };
const snapshot = { poolAddress: POOL, token0: WETH, token1: TOKEN,
  reserve0: "1000000", reserve1: "2000000", blockNumber: 42, feeBps: 30 };

test("builds an immutable exact-spend V2 buy from a matching chain snapshot", () => {
  const first = buildLiveV2BuyIntent({ candidate, snapshot, config,
    amountInWei: "1000", slippageBps: 100, now: 1_000_000 });
  const second = buildLiveV2BuyIntent({ candidate, snapshot, config,
    amountInWei: "1000", slippageBps: 100, now: 1_000_000 });
  assert.ok(Object.isFrozen(first));
  assert.equal(first.id, second.id);
  assert.equal(first.spendAsset, WETH);
  assert.equal(first.spendAmount, "1000");
  const call = decodeFunctionData({ abi: V2_ROUTER_ABI, data: first.data });
  assert.equal(call.functionName, "swapExactTokensForTokens");
  assert.equal(call.args[0], 1000n);
  assert.ok(call.args[1] > 0n);
  assert.deepEqual(call.args[2].map((value) => value.toLowerCase()), [WETH, TOKEN]);
  assert.equal(call.args[3].toLowerCase(), WALLET);
  assert.equal(call.args[4], 1060n);
});

test("rejects observer hints that do not match fresh chain identity", () => {
  assert.throws(() => buildLiveV2BuyIntent({ candidate,
    snapshot: { ...snapshot, token1: ROUTER }, config,
    amountInWei: "1", slippageBps: 100 }), /live-candidate-chain-mismatch/);
});

test("rejects non-allowlisted routers and spend above the cap", () => {
  assert.throws(() => buildLiveV2BuyIntent({ candidate: { ...candidate, router: TOKEN },
    snapshot, config, amountInWei: "1", slippageBps: 100 }), /live-router-not-allowed/);
  assert.throws(() => buildLiveV2BuyIntent({ candidate, snapshot, config,
    amountInWei: "1001", slippageBps: 100 }), /live-amount-in-limit/);
});

test("builds a full-unit sell back to WETH from the durable position", () => {
  const position = { poolAddress: POOL, baseToken: TOKEN, routerAddress: ROUTER,
    baseUnits: "123", feeBps: 30, entryIntentId: "live:v2:buy:x" };
  const intent = buildLiveV2SellIntent({ position, snapshot, config,
    slippageBps: 100, deadlineSeconds: 60, now: 1_000_000 });
  const decoded = decodeFunctionData({ abi: V2_ROUTER_ABI, data: intent.data });
  assert.equal(intent.purpose, "live-v2-sell");
  assert.equal(intent.spendAsset, TOKEN.toLowerCase());
  assert.equal(intent.spendAmount, "123");
  assert.deepEqual(decoded.args[2].map((item) => item.toLowerCase()),
    [TOKEN.toLowerCase(), WETH.toLowerCase()]);
});

test("binds buy and sell intent identities to their exact calldata deadline", () => {
  const later = 1_001_000;
  const buyA = buildLiveV2BuyIntent({ candidate, snapshot, config,
    amountInWei: "100", slippageBps: 100, now: 1_000_000 });
  const buyB = buildLiveV2BuyIntent({ candidate, snapshot, config,
    amountInWei: "100", slippageBps: 100, now: later });
  const position = { poolAddress: POOL, baseToken: TOKEN, routerAddress: ROUTER,
    baseUnits: "123", feeBps: 30, entryIntentId: "live:v2:buy:x" };
  const sellA = buildLiveV2SellIntent({ position, snapshot, config,
    slippageBps: 100, now: 1_000_000 });
  const sellB = buildLiveV2SellIntent({ position, snapshot, config,
    slippageBps: 100, now: later });
  assert.notEqual(buyA.id, buyB.id);
  assert.notEqual(sellA.id, sellB.id);
});
