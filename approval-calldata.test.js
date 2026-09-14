import test from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData } from "viem";
import { APPROVE_ABI, MAX_UINT256, validateApprovalCalldata } from "./approval-calldata.js";

const wallet = "0x1111111111111111111111111111111111111111";
const token = "0x2222222222222222222222222222222222222222";
const router = "0x3333333333333333333333333333333333333333";
const foreign = "0x4444444444444444444444444444444444444444";
const policy = {
  walletAddress: wallet,
  allowedApprovalSpenders: [router],
  approvalLimits: { [token]: { maxAmount: "1000" } },
};

function intent(spender = router, amount = 100n, overrides = {}) {
  return {
    from: wallet, to: token, valueWei: "0",
    data: encodeFunctionData({ abi: APPROVE_ABI, functionName: "approve", args: [spender, amount] }),
    ...overrides,
  };
}

test("accepts only the exact planned token approval", () => {
  const result = validateApprovalCalldata(intent(), policy, { spender: router, amount: "100" });
  assert.equal(result.approved, true);
  assert.equal(result.call.amount, 100n);
});

test("rejects unlimited, excessive, and mismatched approvals", () => {
  assert.ok(validateApprovalCalldata(intent(router, MAX_UINT256), policy,
    { spender: router, amount: MAX_UINT256 }).failures.includes("unlimited-approval"));
  assert.ok(validateApprovalCalldata(intent(router, 1001n), policy,
    { spender: router, amount: 1001n }).failures.includes("approval-amount-limit"));
  assert.ok(validateApprovalCalldata(intent(router, 99n), policy,
    { spender: router, amount: 100n }).failures.includes("approval-amount-mismatch"));
});

test("rejects foreign spenders, tokens, and attached native value", () => {
  const failures = validateApprovalCalldata(intent(foreign, 100n, {
    to: foreign, valueWei: "1",
  }), policy, { spender: router, amount: 100n }).failures;
  assert.deepEqual(failures, [
    "unexpected-approval-value", "approval-token-not-allowed",
    "approval-spender-not-allowed", "approval-spender-mismatch",
  ]);
});

test("rejects arbitrary token calldata", () => {
  assert.deepEqual(validateApprovalCalldata({ ...intent(), data: "0x12345678" }, policy,
    { spender: router, amount: 100n }).failures, ["unsupported-approval-calldata"]);
});
