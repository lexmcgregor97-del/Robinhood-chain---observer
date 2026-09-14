import { simulateV2RoundTrip } from "./v2-simulator.js";
import { normalizedV3Price, simulateV3RoundTrip } from "./v3-simulator.js";

const lower = (value) => String(value || "").toLowerCase();

export function decodeV2Reserves(result) {
  if (!/^0x[0-9a-fA-F]{192,}$/.test(result || "")) throw new Error("invalid-getReserves-result");
  return {
    reserve0: BigInt(`0x${result.slice(2, 66)}`),
    reserve1: BigInt(`0x${result.slice(66, 130)}`),
  };
}

export function evaluateV2MarketSafety(pool, options) {
  const latestBlock = Number(options.latestBlock);
  const quoteAmountIn = BigInt(options.quoteAmountIn);
  const quoteTokens = new Set(options.quoteTokens.map(lower));
  const token0IsQuote = quoteTokens.has(lower(pool.token0));
  const token1IsQuote = quoteTokens.has(lower(pool.token1));
  const quoteTokenKnown = token0IsQuote !== token1IsQuote;
  const base = {
    quoteTokenKnown,
    quoteToken: token0IsQuote ? lower(pool.token0) : token1IsQuote ? lower(pool.token1) : null,
    baseToken: token0IsQuote ? lower(pool.token1) : token1IsQuote ? lower(pool.token0) : null,
    tokenPriceQuote: null,
    liquidityKnown: false,
    buySimulationOk: false,
    sellSimulationOk: false,
    poolAgeBlocks: Number.isFinite(latestBlock) ? latestBlock - Number(pool.discoveryBlock) : null,
    priceImpactPct: null,
    roundTripLossPct: null,
  };
  if (pool.version !== "v2" || !quoteTokenKnown) return base;
  const reserveQuote = token0IsQuote ? BigInt(options.reserve0) : BigInt(options.reserve1);
  const reserveToken = token0IsQuote ? BigInt(options.reserve1) : BigInt(options.reserve0);
  if (reserveQuote <= 0n || reserveToken <= 0n || quoteAmountIn <= 0n) return base;
  try {
    const simulation = simulateV2RoundTrip({
      reserveQuote,
      reserveToken,
      quoteAmountIn,
      feeBps: pool.dex === "pancakeswap" ? 25 : 30,
    });
    const quoteDecimals = Number(token0IsQuote ? options.token0Decimals : options.token1Decimals);
    const tokenDecimals = Number(token0IsQuote ? options.token1Decimals : options.token0Decimals);
    const quoteHuman = Number(reserveQuote) / (10 ** quoteDecimals);
    const tokenHuman = Number(reserveToken) / (10 ** tokenDecimals);
    const tokenPriceQuote = quoteHuman > 0 && tokenHuman > 0 ? quoteHuman / tokenHuman : null;
    return {
      ...base,
      tokenPriceQuote: Number.isFinite(tokenPriceQuote) ? tokenPriceQuote : null,
      liquidityKnown: true,
      reserveQuote: reserveQuote.toString(),
      reserveToken: reserveToken.toString(),
      quoteAmountIn: quoteAmountIn.toString(),
      buySimulationOk: simulation.buyAmountOut > 0n,
      sellSimulationOk: simulation.sellAmountOut > 0n,
      priceImpactPct: simulation.buyPriceImpactBps / 100,
      roundTripLossPct: simulation.roundTripLossBps / 100,
    };
  } catch (error) {
    return { ...base, liquidityKnown: true,
      simulationError: error instanceof Error ? error.message : String(error) };
  }
}


export function evaluateV3MarketSafety(pool, options) {
  const quoteTokens = new Set(options.quoteTokens.map(lower));
  const token0IsQuote = quoteTokens.has(lower(pool.token0));
  const token1IsQuote = quoteTokens.has(lower(pool.token1));
  const quoteTokenKnown = token0IsQuote !== token1IsQuote;
  const base = {
    quoteTokenKnown,
    quoteToken: token0IsQuote ? lower(pool.token0) : token1IsQuote ? lower(pool.token1) : null,
    baseToken: token0IsQuote ? lower(pool.token1) : token1IsQuote ? lower(pool.token0) : null,
    tokenPriceQuote: null,
    liquidityKnown: false,
    buySimulationOk: false,
    sellSimulationOk: false,
    tickBoundaryKnown: false,
    simulationScope: "same-tick-only",
    poolAgeBlocks: Number(options.latestBlock) - Number(pool.discoveryBlock),
    priceImpactPct: null,
    roundTripLossPct: null,
  };
  if (pool.version !== "v3" || !quoteTokenKnown) return base;
  try {
    const liquidity = BigInt(options.liquidity);
    const quoteAmountIn = BigInt(options.quoteAmountIn);
    if (liquidity <= 0n || quoteAmountIn <= 0n) return base;
    const tokenPriceQuote = normalizedV3Price({
      sqrtPriceX96: options.sqrtPriceX96,
      token0Decimals: options.token0Decimals,
      token1Decimals: options.token1Decimals,
      quoteIsToken0: token0IsQuote,
    });
    const simulation = simulateV3RoundTrip({
      sqrtPriceX96: options.sqrtPriceX96,
      liquidity,
      quoteAmountIn,
      quoteIsToken0: token0IsQuote,
      feeBps: Math.ceil(Number(pool.fee) / 100),
    });
    return {
      ...base,
      tokenPriceQuote,
      liquidityKnown: true,
      activeLiquidity: liquidity.toString(),
      currentTick: Number(options.currentTick),
      quoteAmountIn: quoteAmountIn.toString(),
      buySimulationOk: simulation.buyAmountOut > 0n,
      sellSimulationOk: simulation.sellAmountOut > 0n,
      priceImpactPct: simulation.priceImpactBps / 100,
      roundTripLossPct: simulation.roundTripLossBps / 100,
    };
  } catch (error) {
    return { ...base, measurementError: error instanceof Error ? error.message : String(error) };
  }
}
