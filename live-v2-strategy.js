import { decodeEventLog, decodeFunctionResult, encodeEventTopics, encodeFunctionData,
  getAddress, isAddressEqual, parseAbiItem } from "viem";
import { decodeSwapEvent } from "./market-data.js";
import { evaluateV2MarketSafety } from "./market-safety.js";
import { auditSwapPrice } from "./price-audit.js";
import { evaluateRiskGate } from "./risk-gate.js";
import { scorePool } from "./signals.js";

const PAIR_CREATED = parseAbiItem(
  "event PairCreated(address indexed token0, address indexed token1, address pair, uint256)",
);
const SWAP = parseAbiItem(
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
);
const FACTORY_ABI = Object.freeze([{ type: "function", name: "getPair", stateMutability: "view",
  inputs: [{ name: "tokenA", type: "address" }, { name: "tokenB", type: "address" }],
  outputs: [{ name: "pair", type: "address" }] }]);
const hex = (value) => `0x${BigInt(value).toString(16)}`;
const number = (value, failure) => {
  try {
    const parsed = Number(BigInt(value));
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error();
    return parsed;
  } catch { throw new Error(failure); }
};

async function blockTime(rpc, blockNumber) {
  const block = await rpc("eth_getBlockByNumber", [hex(blockNumber), false]);
  return number(block?.timestamp, "live-strategy-block-time-invalid") * 1_000;
}

async function verifyPoolCreation({ candidate, chain, factory, rpc }) {
  const data = encodeFunctionData({ abi: FACTORY_ABI, functionName: "getPair",
    args: [getAddress(chain.token0), getAddress(chain.token1)] });
  const result = await rpc("eth_call", [{ to: factory, data }, chain.pinnedBlock]);
  const pair = decodeFunctionResult({ abi: FACTORY_ABI, functionName: "getPair", data: result });
  if (!isAddressEqual(pair, chain.poolAddress)) throw new Error("live-pool-factory-mismatch");
  const discoveryBlock = Number(candidate.discoveryBlock);
  if (!Number.isSafeInteger(discoveryBlock) || discoveryBlock < 0
      || discoveryBlock > chain.blockNumber) throw new Error("live-pool-discovery-block-invalid");
  const logs = await rpc("eth_getLogs", [{ address: factory, fromBlock: hex(discoveryBlock),
    toBlock: hex(discoveryBlock), topics: encodeEventTopics({ abi: [PAIR_CREATED],
      eventName: "PairCreated", args: { token0: chain.token0, token1: chain.token1 } }) }]);
  const found = (logs || []).some((log) => {
    try {
      const decoded = decodeEventLog({ abi: [PAIR_CREATED], data: log.data,
        topics: log.topics, strict: true });
      return isAddressEqual(decoded.args.pair ?? decoded.args[2], chain.poolAddress);
    } catch { return false; }
  });
  if (!found) throw new Error("live-pool-creation-event-not-found");
  return { discoveryBlock, discoveryTimestampMs: await blockTime(rpc, discoveryBlock) };
}

export async function identifyLiveV2Factory({ chain, rpc, config } = {}) {
  const matches = [];
  for (const [dex, configured] of Object.entries(config?.factories || {})) {
    const factory = getAddress(configured);
    const data = encodeFunctionData({ abi: FACTORY_ABI, functionName: "getPair",
      args: [getAddress(chain.token0), getAddress(chain.token1)] });
    const result = await rpc("eth_call", [{ to: factory, data }, chain.pinnedBlock]);
    const pair = decodeFunctionResult({ abi: FACTORY_ABI, functionName: "getPair", data: result });
    if (isAddressEqual(pair, chain.poolAddress)) matches.push({ dex, factory: factory.toLowerCase(),
      feeBps: Number(config.factoryFeeBps?.[factory.toLowerCase()]) });
  }
  if (matches.length !== 1 || !new Set([25, 30]).has(matches[0].feeBps)) {
    throw new Error("live-pool-factory-identity-invalid");
  }
  return Object.freeze(matches[0]);
}

export async function assessIndependentV2Strategy({ candidate, chain, rpc, config,
  now = Date.now() } = {}) {
  if (candidate?.version !== "v2" || typeof rpc !== "function") {
    return Object.freeze({ approved: false, failures: ["live-strategy-v2-required"] });
  }
  try {
    const factory = getAddress(config?.factories?.[candidate.dex]);
    const feeBps = Number(config?.factoryFeeBps?.[factory.toLowerCase()]);
    if (!new Set([25, 30]).has(feeBps)) throw new Error("live-factory-fee-invalid");
    const created = await verifyPoolCreation({ candidate, chain, factory, rpc });
    const lookbackBlocks = Number(config.signalLookbackBlocks);
    if (!Number.isSafeInteger(lookbackBlocks) || lookbackBlocks <= 0) {
      throw new Error("live-signal-lookback-invalid");
    }
    const fromBlock = Math.max(created.discoveryBlock, chain.blockNumber - lookbackBlocks + 1);
    const logs = await rpc("eth_getLogs", [{ address: chain.poolAddress,
      fromBlock: hex(fromBlock), toBlock: chain.pinnedBlock,
      topics: encodeEventTopics({ abi: [SWAP], eventName: "Swap" }) }]);
    if (!Array.isArray(logs)) throw new Error("live-swap-log-result-invalid");
    const identities = new Set();
    const ordered = [...logs].map((log) => {
      const blockNumber = number(log.blockNumber, "live-swap-log-invalid");
      const logIndex = number(log.logIndex, "live-swap-log-invalid");
      const identity = `${String(log.transactionHash).toLowerCase()}:${logIndex}`;
      if (identities.has(identity) || log.removed === true
          || !isAddressEqual(log.address, chain.poolAddress)) throw new Error("live-swap-log-invalid");
      identities.add(identity);
      return { ...log, blockNumber, logIndex };
    }).sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
    const blockNumbers = [...new Set(ordered.map((log) => log.blockNumber))];
    const times = new Map(await Promise.all(blockNumbers.map(async (block) =>
      [block, await blockTime(rpc, block)])));
    const recentBlocks = blockNumbers.map((block) => ({ blockNumber: block,
      timestampMs: times.get(block), count: ordered.filter((log) => log.blockNumber === block).length }));
    const signal = scorePool({ recentBlocks,
      lastSwapTimestampMs: times.get(ordered.at(-1)?.blockNumber) || 0 }, chain.blockTimestampMs, {
      windowMs: config.signalWindowMs, baselineMs: config.signalBaselineMs,
      minSwaps: config.signalMinSwaps });
    const verifiedDex = feeBps === 25 ? "pancakeswap" : "uniswap";
    const pool = { ...candidate, dex: verifiedDex, token0: chain.token0, token1: chain.token1,
      discoveryBlock: created.discoveryBlock };
    const safetyBase = evaluateV2MarketSafety(pool, { latestBlock: chain.blockNumber,
      quoteAmountIn: config.amountInWei, quoteTokens: [config.wethAddress],
      reserve0: chain.reserve0, reserve1: chain.reserve1,
      token0Decimals: chain.token0Decimals, token1Decimals: chain.token1Decimals });
    const lastSwap = ordered.length ? decodeSwapEvent(ordered.at(-1), "v2") : null;
    const priceAudit = auditSwapPrice({ spotPriceQuote: safetyBase.tokenPriceQuote,
      swap: lastSwap, quoteIsToken0: isAddressEqual(chain.token0, config.wethAddress),
      token0Decimals: chain.token0Decimals, token1Decimals: chain.token1Decimals });
    const marketSafety = { ...safetyBase, ...priceAudit,
      poolAgeMs: chain.blockTimestampMs - created.discoveryTimestampMs };
    const risk = evaluateRiskGate({ ...pool, signal, marketSafety }, config.riskPolicy);
    return Object.freeze({ approved: risk.eligibleForPaperEntry, failures: risk.failures, feeBps,
      signal: Object.freeze(signal), marketSafety: Object.freeze(marketSafety),
      lastSwap: lastSwap ? Object.freeze({ ...lastSwap,
        blockNumber: ordered.at(-1).blockNumber,
        transactionHash: ordered.at(-1).transactionHash }) : null });
  } catch (error) {
    return Object.freeze({ approved: false,
      failures: Object.freeze([error instanceof Error ? error.message : "live-strategy-failed"]) });
  }
}

export { FACTORY_ABI, PAIR_CREATED, SWAP };
