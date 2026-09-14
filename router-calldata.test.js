import test from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData } from "viem";
import { V2_ROUTER_ABI, validateV2RouterCalldata } from "./router-calldata.js";

const wallet = "0x1111111111111111111111111111111111111111";
const weth = "0x2222222222222222222222222222222222222222";
const token = "0x3333333333333333333333333333333333333333";
const policy = { walletAddress: wallet, allowedPaths: [[weth, token]], maxRouterDeadlineSeconds: 60 };

function intent(overrides = {}) {
  return {
    valueWei: "100",
    data: encodeFunctionData({
      abi: V2_ROUTER_ABI,
      functionName: "swapExactETHForTokens",
      args: [90n, [weth, token], wallet, 1_050n],
    }),
    ...overrides,
  };
}

test("accepts a bounded exact-input V2 call", () => {
  const result = validateV2RouterCalldata(intent(), policy, { nowSeconds: 1_000 });
  assert.equal(result.approved, true);
  assert.equal(result.call.amountOutMin, 90n);
  assert.equal(result.call.recipient.toLowerCase(), wallet);
});

test("rejects zero output, foreign recipient, path, and distant deadline", () => {
  const data = encodeFunctionData({
    abi: V2_ROUTER_ABI,
    functionName: "swapExactETHForTokens",
    args: [0n, [token, weth], token, 2_000n],
  });
  assert.deepEqual(
    validateV2RouterCalldata(intent({ data }), policy, { nowSeconds: 1_000 }).failures,
    ["zero-minimum-output", "recipient-mismatch", "path-not-allowed", "router-deadline-too-distant"],
  );
});

test("rejects native value attached to a token-input swap", () => {
  const data = encodeFunctionData({
    abi: V2_ROUTER_ABI,
    functionName: "swapExactTokensForTokens",
    args: [100n, 90n, [weth, token], wallet, 1_050n],
  });
  assert.deepEqual(
    validateV2RouterCalldata(intent({ data }), policy, { nowSeconds: 1_000 }).failures,
    ["unexpected-transaction-value"],
  );
});

test("rejects unknown selectors and malformed data", () => {
  assert.deepEqual(
    validateV2RouterCalldata(intent({ data: "0x12345678" }), policy).failures,
    ["unsupported-router-calldata"],
  );
});
