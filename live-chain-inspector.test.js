import test from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, encodeFunctionResult } from "viem";
import { createLiveCandidateInspector, ERC20_READ_ABI, readLiveV2ChainSnapshot,
  V2_PAIR_ABI } from "./live-chain-inspector.js";

const WETH = "0x0000000000000000000000000000000000000001";
const TOKEN = "0x0000000000000000000000000000000000000002";
const POOL = "0x0000000000000000000000000000000000000003";
const ROUTER = "0x0000000000000000000000000000000000000004";
const WALLET = "0x0000000000000000000000000000000000000005";
const candidate = { version: "v2", dex: "uniswap", address: POOL };
const config = { walletAddress: WALLET, wethAddress: WETH, routerAddress: ROUTER };

function fakeRpc(calls) {
  return async (method, params) => {
    calls.push([method, params]);
    if (method === "eth_blockNumber") return "0x2a";
    if (method === "eth_getBlockByNumber") return { timestamp: "0x1" };
    if (method === "eth_getBalance") return "0x32";
    const decodedPair = params[0].to.toLowerCase() === POOL
      ? decodeFunctionData({ abi: V2_PAIR_ABI, data: params[0].data }) : null;
    if (decodedPair?.functionName === "token0") return encodeFunctionResult({
      abi: V2_PAIR_ABI, functionName: "token0", result: WETH });
    if (decodedPair?.functionName === "token1") return encodeFunctionResult({
      abi: V2_PAIR_ABI, functionName: "token1", result: TOKEN });
    if (decodedPair?.functionName === "getReserves") return encodeFunctionResult({
      abi: V2_PAIR_ABI, functionName: "getReserves", result: [1000n, 2000n, 1] });
    const erc20 = decodeFunctionData({ abi: ERC20_READ_ABI, data: params[0].data });
    return encodeFunctionResult({ abi: ERC20_READ_ABI, functionName: erc20.functionName,
      result: erc20.functionName === "balanceOf" ? 100n
        : erc20.functionName === "allowance" ? 75n : 18 });
  };
}

test("pins every chain read to one block and orients WETH reserves", async () => {
  const calls = [];
  const result = await readLiveV2ChainSnapshot({ candidate, config, rpc: fakeRpc(calls), now: 9 });
  assert.equal(result.blockNumber, 42);
  assert.equal(result.latestBlock, 42);
  assert.equal(result.reserveIn, "1000");
  assert.equal(result.reserveOut, "2000");
  assert.equal(result.wethBalanceWei, "100");
  assert.equal(result.allowanceWei, "75");
  assert.equal(result.nativeBalanceWei, "50");
  assert.equal(result.token0Decimals, 18);
  assert.equal(result.blockTimestampMs, 1000);
  for (const [method, params] of calls.slice(1)) {
    if (method === "eth_call" || method === "eth_getBalance") {
      assert.equal(params.at(-1), "0x2a", method);
    }
  }
});

test("construction and preflight use independently invoked checks", async () => {
  const counts = { strategy: 0, readiness: 0, signing: 0, sell: 0 };
  const inspect = createLiveCandidateInspector({ config, rpc: fakeRpc([]),
    assessStrategy: async () => ({ approved: ++counts.strategy > 0, failures: [] }),
    assessReadiness: async () => (counts.readiness++, { eligibleForMicroMainnet: true }),
    verifySigning: async () => (counts.signing++, { credentialVerified: true, policyVerified: true }),
    probeSell: async () => (counts.sell++, { passed: true, checkedAt: new Date(9).toISOString() }),
    minimumNativeBalanceWei: "1", maximumAllowanceWei: "75" });
  assert.equal((await inspect(candidate, { phase: "construction", now: 9 })).strategyApproved, true);
  const result = await inspect(candidate, { phase: "preflight", now: 10 });
  assert.equal(result.chain.observedAt, 10);
  assert.deepEqual(counts, { strategy: 2, readiness: 1, signing: 1, sell: 1 });
});
