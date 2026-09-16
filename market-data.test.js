import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeEventTopics, parseAbiItem } from "viem";
import { decodeSwapEvent, isV2SellToQuote } from "./market-data.js";

const v2Event = parseAbiItem(
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
);
const address = "0x0000000000000000000000000000000000000001";

test("decodes a V2 token0-to-token1 swap", () => {
  const topics = encodeEventTopics({ abi: [v2Event], eventName: "Swap", args: { sender: address, to: address } });
  const data = encodeAbiParameters([
    { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" },
  ], [1_000_000_000_000_000_000n, 0n, 0n, 2_000_000n]);
  const decoded = decodeSwapEvent({ topics, data }, "v2");
  assert.equal(decoded.direction, "token0-to-token1");
  assert.equal(decoded.amount0, "1000000000000000000");
  assert.equal(decoded.amount1, "-2000000");
  assert.equal(decoded.protocol, "amm-v2");
});

test("rejects a malformed zero-leg swap", () => {
  const topics = encodeEventTopics({ abi: [v2Event], eventName: "Swap", args: { sender: address, to: address } });
  const data = encodeAbiParameters([
    { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" },
  ], [1n, 0n, 0n, 0n]);
  assert.throws(() => decodeSwapEvent({ topics, data }, "v2"), /zero token leg/);
});

test("identifies a V2 sell independently of later buy activity", () => {
  const quote = "0x0000000000000000000000000000000000000010";
  const base = "0x0000000000000000000000000000000000000020";
  const pool = { version: "v2", token0: quote, token1: base };
  assert.equal(isV2SellToQuote(pool, { direction: "token1-to-token0" }, [quote]), true);
  assert.equal(isV2SellToQuote(pool, { direction: "token0-to-token1" }, [quote]), false);
  assert.equal(isV2SellToQuote({ ...pool, token0: base, token1: quote },
    { direction: "token0-to-token1" }, [quote]), true);
  assert.equal(isV2SellToQuote({ ...pool, version: "v3" },
    { direction: "token1-to-token0" }, [quote]), false);
});
