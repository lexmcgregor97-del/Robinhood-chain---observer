import { decodeEventLog, parseAbiItem } from "viem";
import { ROBINHOOD } from "./chain-config.js";

export const V4_INITIALIZE_EVENT = parseAbiItem(
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
);
export const V4_SWAP_EVENT = parseAbiItem(
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
);

const normalizeAddress = (value) => String(value || "").toLowerCase();

function assertPoolManager(log, expectedPoolManager) {
  if (normalizeAddress(log?.address) !== normalizeAddress(expectedPoolManager)) {
    throw new Error("v4-pool-manager-mismatch");
  }
}

export function decodeV4InitializeObservation(
  log,
  expectedPoolManager = ROBINHOOD.uniswapV4.poolManager,
) {
  assertPoolManager(log, expectedPoolManager);
  const decoded = decodeEventLog({
    abi: [V4_INITIALIZE_EVENT], data: log.data, topics: log.topics,
    strict: true,
  });
  const { id, currency0, currency1, fee, tickSpacing, hooks, sqrtPriceX96, tick } = decoded.args;
  return {
    kind: "v4-initialize-observation",
    version: "v4",
    poolManager: expectedPoolManager,
    poolId: id,
    currency0,
    currency1,
    fee: Number(fee),
    tickSpacing: Number(tickSpacing),
    hooks,
    hooked: normalizeAddress(hooks) !== "0x0000000000000000000000000000000000000000",
    sqrtPriceX96: String(sqrtPriceX96),
    tick: Number(tick),
    blockNumber: log.blockNumber == null ? null : String(log.blockNumber),
    transactionHash: log.transactionHash || null,
    observationOnly: true,
    paperEligible: false,
    executionSupported: false,
  };
}

export function decodeV4SwapObservation(
  log,
  expectedPoolManager = ROBINHOOD.uniswapV4.poolManager,
) {
  assertPoolManager(log, expectedPoolManager);
  const decoded = decodeEventLog({
    abi: [V4_SWAP_EVENT], data: log.data, topics: log.topics,
    strict: true,
  });
  const { id, sender, amount0, amount1, sqrtPriceX96, liquidity, tick, fee } = decoded.args;
  if (amount0 === 0n || amount1 === 0n || (amount0 > 0n) === (amount1 > 0n)) {
    throw new Error("invalid-v4-swap-delta");
  }
  return {
    kind: "v4-swap-observation",
    version: "v4",
    poolManager: expectedPoolManager,
    poolId: id,
    sender,
    amount0: String(amount0),
    amount1: String(amount1),
    sqrtPriceX96: String(sqrtPriceX96),
    liquidity: String(liquidity),
    tick: Number(tick),
    fee: Number(fee),
    blockNumber: log.blockNumber == null ? null : String(log.blockNumber),
    transactionHash: log.transactionHash || null,
    observationOnly: true,
    paperEligible: false,
    executionSupported: false,
  };
}

export const V4_COVERAGE_BOUNDARY = Object.freeze({
  observationSupported: true,
  discoveryWired: false,
  pricingSupported: false,
  hookSimulationSupported: false,
  paperEligible: false,
  executionSupported: false,
  activationRequired: Object.freeze([
    "pool-discovery-and-stateview-reader",
    "hook-aware-price-and-delta-simulation",
    "exact-buy-and-sell-quote-validation",
    "sellability-proof",
    "adversarial-review",
  ]),
});
