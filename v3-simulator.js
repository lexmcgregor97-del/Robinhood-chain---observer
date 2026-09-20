const Q96 = 1n << 96n;
const BPS = 10_000n;

const positive = (value, name) => {
  const parsed = BigInt(value);
  if (parsed <= 0n) throw new Error(`${name} must be positive`);
  return parsed;
};

export function decodeV3Slot0(result) {
  if (!/^0x[0-9a-fA-F]{128,}$/.test(result || "")) throw new Error("invalid-slot0-result");
  const sqrtPriceX96 = BigInt(`0x${result.slice(2, 66)}`);
  let tick = Number.parseInt(result.slice(66, 130), 16);
  if (tick >= 0x800000) tick -= 0x1000000;
  return { sqrtPriceX96, tick };
}

export function decodeUint(result, name = "uint") {
  if (!/^0x[0-9a-fA-F]{64,}$/.test(result || "")) throw new Error(`invalid-${name}-result`);
  return BigInt(`0x${result.slice(2, 66)}`);
}

export function normalizedV3Price({ sqrtPriceX96, token0Decimals, token1Decimals, quoteIsToken0 }) {
  const sqrt = Number(positive(sqrtPriceX96, "sqrtPriceX96")) / Number(Q96);
  const rawToken1PerToken0 = sqrt * sqrt;
  const humanToken1PerToken0 = rawToken1PerToken0
    * (10 ** Number(token0Decimals)) / (10 ** Number(token1Decimals));
  const price = quoteIsToken0 ? 1 / humanToken1PerToken0 : humanToken1PerToken0;
  if (!Number.isFinite(price) || price <= 0) throw new Error("invalid-normalized-price");
  return price;
}

export function quoteV3WithinTick({
  sqrtPriceX96, liquidity, amountIn, zeroForOne, feeBps,
}) {
  const sqrt = positive(sqrtPriceX96, "sqrtPriceX96");
  const L = positive(liquidity, "liquidity");
  const input = positive(amountIn, "amountIn");
  const fee = BigInt(feeBps);
  if (fee < 0n || fee >= BPS) throw new Error("invalid-fee-bps");
  const net = input * (BPS - fee) / BPS;
  if (net <= 0n) throw new Error("input-lost-to-fee");
  if (zeroForOne) {
    const denominator = L * Q96 + net * sqrt;
    const next = L * sqrt * Q96 / denominator;
    const output = L * (sqrt - next) / Q96;
    if (next <= 0n || output <= 0n) throw new Error("insufficient-output");
    return { amountOut: output, nextSqrtPriceX96: next };
  }
  const next = sqrt + net * Q96 / L;
  const output = L * (next - sqrt) * Q96 / (next * sqrt);
  if (output <= 0n) throw new Error("insufficient-output");
  return { amountOut: output, nextSqrtPriceX96: next };
}

export function simulateV3RoundTrip({
  sqrtPriceX96, liquidity, quoteAmountIn, quoteIsToken0, feeBps,
}) {
  const input = positive(quoteAmountIn, "quoteAmountIn");
  const buy = quoteV3WithinTick({
    sqrtPriceX96, liquidity, amountIn: input, zeroForOne: quoteIsToken0, feeBps,
  });
  const sell = quoteV3WithinTick({
    sqrtPriceX96: buy.nextSqrtPriceX96, liquidity, amountIn: buy.amountOut,
    zeroForOne: !quoteIsToken0, feeBps,
  });
  const loss = input - sell.amountOut;
  const roundTripLossBps = Number(loss * BPS / input);
  const start = Number(positive(sqrtPriceX96, "sqrtPriceX96"));
  const end = Number(buy.nextSqrtPriceX96);
  const priceRatio = (end / start) ** 2;
  const priceImpactBps = Math.round(Math.abs(1 - priceRatio) * 10_000);
  const sellStart = Number(buy.nextSqrtPriceX96);
  const sellEnd = Number(sell.nextSqrtPriceX96);
  const sellPriceRatio = (sellEnd / sellStart) ** 2;
  const sellPriceImpactBps = Math.round(Math.abs(1 - sellPriceRatio) * 10_000);
  return {
    buyAmountOut: buy.amountOut,
    sellAmountOut: sell.amountOut,
    nextSqrtPriceX96: buy.nextSqrtPriceX96,
    priceImpactBps,
    sellPriceImpactBps,
    roundTripLossBps,
  };
}
