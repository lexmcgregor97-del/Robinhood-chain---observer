import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionResult } from "viem";
import { assessIndependentV2Strategy, FACTORY_ABI, PAIR_CREATED, SWAP }
  from "./live-v2-strategy.js";

const WETH = "0x0000000000000000000000000000000000000001";
const TOKEN = "0x0000000000000000000000000000000000000002";
const POOL = "0x0000000000000000000000000000000000000003";
const FACTORY = "0x0000000000000000000000000000000000000004";
const USER = "0x0000000000000000000000000000000000000005";
const candidate = { version: "v2", dex: "uniswap", address: POOL,
  discoveryBlock: 1, token0: WETH, token1: TOKEN };
const chain = { poolAddress: POOL, token0: WETH, token1: TOKEN,
  reserve0: "1000000", reserve1: "1000000", token0Decimals: 18,
  token1Decimals: 18, blockNumber: 100, pinnedBlock: "0x64",
  blockTimestampMs: 1_000_000 };
const config = { factories: { uniswap: FACTORY }, signalLookbackBlocks: 20,
  factoryFeeBps: { [FACTORY]: 30 },
  signalWindowMs: 60_000, signalBaselineMs: 300_000, signalMinSwaps: 3,
  amountInWei: "100", wethAddress: WETH,
  riskPolicy: { minPoolAgeMs: 300_000, maxPriceImpactPct: 5,
    maxExecutionCostPct: 15, maxSpotSwapDeviationPct: 5,
    requiredSignal: "escape-velocity" } };

const pairLog = { address: FACTORY,
  topics: encodeEventTopics({ abi: [PAIR_CREATED], eventName: "PairCreated",
    args: { token0: WETH, token1: TOKEN } }),
  data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [POOL, 1n]) };
const swapTopics = encodeEventTopics({ abi: [SWAP], eventName: "Swap",
  args: { sender: USER, to: USER } });
const swaps = Array.from({ length: 6 }, (_, index) => ({ address: POOL,
  blockNumber: "0x63", logIndex: `0x${index.toString(16)}`, removed: false,
  transactionHash: `0x${String(index + 1).padStart(64, "0")}`,
  topics: swapTopics,
  data: encodeAbiParameters([
    { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" },
  ], [100n, 0n, 0n, 100n]) }));

test("derives an eligible V2 signal and safety result from its own RPC evidence", async () => {
  const rpc = async (method, params) => {
    if (method === "eth_call") return encodeFunctionResult({ abi: FACTORY_ABI,
      functionName: "getPair", result: POOL });
    if (method === "eth_getBlockByNumber") {
      return { timestamp: params[0] === "0x1" ? "0x1" : "0x3e7" };
    }
    if (method === "eth_getLogs") return params[0].address.toLowerCase() === FACTORY
      ? [pairLog] : swaps;
    throw new Error("unexpected-rpc");
  };
  const result = await assessIndependentV2Strategy({ candidate, chain, config, rpc });
  assert.equal(result.approved, true, JSON.stringify(result));
  assert.equal(result.signal.state, "escape-velocity");
  assert.equal(result.feeBps, 30);
  assert.equal(result.marketSafety.priceAuditAvailable, true);
  assert.equal(result.lastSwap.transactionHash, swaps.at(-1).transactionHash);
});

test("fails closed when the factory does not identify the hinted pool", async () => {
  const rpc = async (method) => method === "eth_call"
    ? encodeFunctionResult({ abi: FACTORY_ABI, functionName: "getPair", result: USER })
    : null;
  const result = await assessIndependentV2Strategy({ candidate, chain, config, rpc });
  assert.deepEqual(result.failures, ["live-pool-factory-mismatch"]);
});
