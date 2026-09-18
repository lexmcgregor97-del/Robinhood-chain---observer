import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeEventTopics, parseAbiParameters } from "viem";
import { ROBINHOOD } from "./chain-config.js";
import {
  V4_COVERAGE_BOUNDARY,
  V4_INITIALIZE_EVENT,
  V4_SWAP_EVENT,
  decodeV4InitializeObservation,
  decodeV4SwapObservation,
} from "./v4-observation.js";

const poolId = `0x${"11".repeat(32)}`;
const currency0 = "0x0000000000000000000000000000000000000000";
const currency1 = ROBINHOOD.usdg;
const sender = "0x1111111111111111111111111111111111111111";

test("decodes a V4 initialization as observation-only coverage", () => {
  const topics = encodeEventTopics({
    abi: [V4_INITIALIZE_EVENT], eventName: "Initialize",
    args: { id: poolId, currency0, currency1 },
  });
  const data = encodeAbiParameters(
    parseAbiParameters("uint24, int24, address, uint160, int24"),
    [3000, 60, sender, 79228162514264337593543950336n, 0],
  );
  const result = decodeV4InitializeObservation({
    address: ROBINHOOD.uniswapV4.poolManager, topics, data,
    blockNumber: 10n, transactionHash: `0x${"22".repeat(32)}`,
  });
  assert.equal(result.poolId, poolId);
  assert.equal(result.hooked, true);
  assert.equal(result.observationOnly, true);
  assert.equal(result.paperEligible, false);
  assert.equal(result.executionSupported, false);
});

test("decodes signed V4 swap deltas without claiming executable support", () => {
  const topics = encodeEventTopics({
    abi: [V4_SWAP_EVENT], eventName: "Swap", args: { id: poolId, sender },
  });
  const data = encodeAbiParameters(
    parseAbiParameters("int128, int128, uint160, uint128, int24, uint24"),
    [1000n, -900n, 79228162514264337593543950336n, 5000n, 0, 3000],
  );
  const result = decodeV4SwapObservation({
    address: ROBINHOOD.uniswapV4.poolManager, topics, data,
  });
  assert.equal(result.amount0, "1000");
  assert.equal(result.amount1, "-900");
  assert.equal(result.paperEligible, false);
});

test("V4 observation fails closed on foreign managers and malformed deltas", () => {
  const topics = encodeEventTopics({
    abi: [V4_SWAP_EVENT], eventName: "Swap", args: { id: poolId, sender },
  });
  const data = encodeAbiParameters(
    parseAbiParameters("int128, int128, uint160, uint128, int24, uint24"),
    [1000n, 900n, 79228162514264337593543950336n, 5000n, 0, 3000],
  );
  assert.throws(() => decodeV4SwapObservation({
    address: sender, topics, data,
  }), /v4-pool-manager-mismatch/);
  assert.throws(() => decodeV4SwapObservation({
    address: ROBINHOOD.uniswapV4.poolManager, topics, data,
  }), /invalid-v4-swap-delta/);
  assert.throws(() => decodeV4SwapObservation({
    address: ROBINHOOD.uniswapV4.poolManager, topics: topics.slice(0, 2), data,
  }));
});

test("coverage boundary requires hook-aware quoting before any activation", () => {
  assert.equal(V4_COVERAGE_BOUNDARY.observationSupported, true);
  assert.equal(V4_COVERAGE_BOUNDARY.discoveryWired, false);
  assert.equal(V4_COVERAGE_BOUNDARY.paperEligible, false);
  assert.equal(V4_COVERAGE_BOUNDARY.executionSupported, false);
  assert.ok(V4_COVERAGE_BOUNDARY.activationRequired.includes(
    "hook-aware-price-and-delta-simulation",
  ));
});
