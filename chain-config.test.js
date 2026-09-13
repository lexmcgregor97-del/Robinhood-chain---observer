import test from "node:test";
import assert from "node:assert/strict";
import { isAddress } from "viem";
import { ROBINHOOD } from "./chain-config.js";

test("pins Robinhood mainnet and canonical quote assets", () => {
  assert.equal(ROBINHOOD.chainId, 4663);
  assert.equal(ROBINHOOD.factories.length, 4);
  assert.ok(isAddress(ROBINHOOD.weth));
  assert.ok(isAddress(ROBINHOOD.usdg));
});

test("keeps every factory and router address valid and unique", () => {
  const addresses = [...ROBINHOOD.factories.map((item) => item.address), ...Object.values(ROBINHOOD.approvedRouters)];
  assert.ok(addresses.every(isAddress));
  assert.equal(new Set(addresses.map((address) => address.toLowerCase())).size, addresses.length);
});
