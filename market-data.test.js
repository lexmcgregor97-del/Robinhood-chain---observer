import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeEventTopics, parseAbiItem } from "viem";
import { decodeSwapEvent, normalizedExecutionPrice } from "./market-data.js";

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
  assert.equal(normalizedExecutionPrice(decoded, 18, 6), 2);
});

test("rejects a malformed zero-leg swap", () => {
  const topics = encodeEventTopics({ abi: [v2Event], eventName: "Swap", args: { sender: address, to: address } });
  const data = encodeAbiParameters([
    { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" },
  ], [1n, 0n, 0n, 0n]);
  assert.throws(() => decodeSwapEvent({ topics, data }, "v2"), /zero token leg/);
});
