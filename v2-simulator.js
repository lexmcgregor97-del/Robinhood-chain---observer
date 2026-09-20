const asPositive = (value, name) => {
  const parsed = BigInt(value);
  if (parsed <= 0n) throw new Error(`${name} must be positive`);
  return parsed;
};

export function quoteV2({ reserveIn, reserveOut, amountIn, feeBps = 25 }) {
  reserveIn = asPositive(reserveIn, "reserveIn");
  reserveOut = asPositive(reserveOut, "reserveOut");
  amountIn = asPositive(amountIn, "amountIn");
  feeBps = BigInt(feeBps);
  if (feeBps < 0n || feeBps >= 10_000n) throw new Error("invalid-fee-bps");
  const amountInAfterFee = amountIn * (10_000n - feeBps);
  const amountOut = amountInAfterFee * reserveOut / (reserveIn * 10_000n + amountInAfterFee);
  if (amountOut <= 0n || amountOut >= reserveOut) throw new Error("insufficient-output");
  const spotNumerator = amountIn * reserveOut;
  const executionNumerator = amountOut * reserveIn;
  const priceImpactBps = Number((spotNumerator - executionNumerator) * 10_000n / spotNumerator);
  return { amountOut, priceImpactBps };
}

export function simulateV2RoundTrip({ reserveQuote, reserveToken, quoteAmountIn, feeBps = 25 }) {
  reserveQuote = asPositive(reserveQuote, "reserveQuote");
  reserveToken = asPositive(reserveToken, "reserveToken");
  quoteAmountIn = asPositive(quoteAmountIn, "quoteAmountIn");
  const buy = quoteV2({ reserveIn: reserveQuote, reserveOut: reserveToken, amountIn: quoteAmountIn, feeBps });
  const quoteReserveAfterBuy = reserveQuote + quoteAmountIn;
  const tokenReserveAfterBuy = reserveToken - buy.amountOut;
  const sell = quoteV2({ reserveIn: tokenReserveAfterBuy, reserveOut: quoteReserveAfterBuy,
    amountIn: buy.amountOut, feeBps });
  const loss = quoteAmountIn - sell.amountOut;
  const roundTripLossBps = Number(loss * 10_000n / quoteAmountIn);
  return {
    buyAmountOut: buy.amountOut,
    sellAmountOut: sell.amountOut,
    buyPriceImpactBps: buy.priceImpactBps,
    sellPriceImpactBps: sell.priceImpactBps,
    roundTripLossBps,
  };
}
