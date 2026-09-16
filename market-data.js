import { decodeEventLog, parseAbiItem } from "viem";

const V2_SWAP_EVENT = parseAbiItem(
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
);
const PANCAKE_V3_SWAP_EVENT = parseAbiItem(
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint128 protocolFeesToken0, uint128 protocolFeesToken1)",
);
const UNISWAP_V3_SWAP_EVENT = parseAbiItem(
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
);

const abs = (value) => value < 0n ? -value : value;

export function decodeSwapEvent(log, version) {
  const abi = version === "v2"
    ? [V2_SWAP_EVENT]
    : [PANCAKE_V3_SWAP_EVENT, UNISWAP_V3_SWAP_EVENT];
  const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics, strict: true });
  const args = decoded.args;
  let amount0;
  let amount1;
  if (version === "v2") {
    amount0 = args.amount0In - args.amount0Out;
    amount1 = args.amount1In - args.amount1Out;
  } else {
    amount0 = args.amount0;
    amount1 = args.amount1;
  }
  if (amount0 === 0n || amount1 === 0n) throw new Error("Swap has a zero token leg");
  return {
    protocol: version === "v2" ? "amm-v2" : "amm-v3",
    direction: amount0 > 0n ? "token0-to-token1" : "token1-to-token0",
    amount0: amount0.toString(),
    amount1: amount1.toString(),
    absoluteAmount0: abs(amount0).toString(),
    absoluteAmount1: abs(amount1).toString(),
    sqrtPriceX96: args.sqrtPriceX96?.toString() ?? null,
    liquidity: args.liquidity?.toString() ?? null,
    tick: args.tick != null ? Number(args.tick) : null,
  };
}

export function isV2SellToQuote(pool, swap, quoteTokens = []) {
  if (pool?.version !== "v2") return false;
  const quotes = new Set(quoteTokens.map((address) => String(address).toLowerCase()));
  const token0IsQuote = quotes.has(String(pool?.token0 || "").toLowerCase());
  const token1IsQuote = quotes.has(String(pool?.token1 || "").toLowerCase());
  if (token0IsQuote === token1IsQuote) return false;
  const expectedDirection = token0IsQuote ? "token1-to-token0" : "token0-to-token1";
  return swap?.direction === expectedDirection;
}
