import test from "node:test";
import assert from "node:assert/strict";
import { createTokenMetadataLoader } from "./token-metadata.js";

const word = (value) => BigInt(value).toString(16).padStart(64, "0");
const bytes32 = (value) => `0x${Buffer.from(value).toString("hex").padEnd(64, "0")}`;

test("returns pinned quote metadata without RPC calls", async () => {
  let calls = 0;
  const load = createTokenMetadataLoader({
    call: async () => { calls += 1; throw new Error("should-not-call"); },
    pinned: [{ address: "0xWETH", symbol: "WETH", decimals: 18 }],
  });
  assert.deepEqual(await load("0xweth"), {
    symbol: "WETH", decimals: 18, pinned: true,
  });
  assert.equal(calls, 0);
});

test("caches only successful metadata lookups", async () => {
  let attempts = 0;
  const load = createTokenMetadataLoader({
    call: async (_address, selector) => {
      attempts += 1;
      if (attempts <= 2) throw new Error("temporary-rpc-error");
      return selector === "0x95d89b41" ? bytes32("TOK") : `0x${word(6)}`;
    },
  });
  await assert.rejects(load("0xtoken"), /temporary-rpc-error/);
  const meta = await load("0xtoken");
  assert.deepEqual(meta, { symbol: "TOK", decimals: 6, pinned: false });
  const before = attempts;
  assert.deepEqual(await load("0xTOKEN"), meta);
  assert.equal(attempts, before);
});

test("rejects empty decimals instead of assuming 18", async () => {
  const load = createTokenMetadataLoader({
    call: async (_address, selector) => selector === "0x95d89b41"
      ? bytes32("TOK") : "0x",
  });
  await assert.rejects(load("0xtoken"), /decimals-unavailable/);
});
