import test from "node:test";
import assert from "node:assert/strict";
import { isAddress } from "viem";
import { ROBINHOOD } from "./chain-config.js";

test("pins Robinhood mainnet and canonical quote assets", () => {
  assert.equal(ROBINHOOD.chainId, 4663);
  assert.equal(ROBINHOOD.factories.length, 4);
  assert.ok(isAddress(ROBINHOOD.weth));
  assert.ok(isAddress(ROBINHOOD.usdg));
  assert.ok(isAddress(ROBINHOOD.uniswapV4.poolManager));
  assert.ok(isAddress(ROBINHOOD.uniswapV4.stateView));
  assert.deepEqual(
    ROBINHOOD.quoteTokens.map(({ symbol, decimals }) => ({ symbol, decimals })),
    [{ symbol: "WETH", decimals: 18 }, { symbol: "USDG", decimals: 6 }],
  );
  assert.deepEqual(
    ROBINHOOD.quoteTokens.map(({ address }) => address.toLowerCase()),
    [ROBINHOOD.weth.toLowerCase(), ROBINHOOD.usdg.toLowerCase()],
  );
});

test("pins V4 contracts only outside the executable factory allowlist", () => {
  const executable = ROBINHOOD.factories.map(({ address }) => address.toLowerCase());
  assert.ok(!executable.includes(ROBINHOOD.uniswapV4.poolManager.toLowerCase()));
  assert.ok(!executable.includes(ROBINHOOD.uniswapV4.stateView.toLowerCase()));
});

test("keeps every factory address valid and unique", () => {
  const addresses = ROBINHOOD.factories.map((item) => item.address);
  assert.ok(addresses.every(isAddress));
  assert.equal(new Set(addresses.map((address) => address.toLowerCase())).size, addresses.length);
});
