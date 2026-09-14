import { decodeFunctionData, getAddress, isAddressEqual } from "viem";

const APPROVE_ABI = [{
  type: "function", name: "approve", stateMutability: "nonpayable",
  inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
  outputs: [{ name: "", type: "bool" }],
}];
const MAX_UINT256 = (1n << 256n) - 1n;
const sameAddress = (left, right) => {
  try { return isAddressEqual(left, right); } catch { return false; }
};

export function validateApprovalCalldata(intent, policy, expected) {
  const failures = [];
  let call;
  try {
    call = decodeFunctionData({ abi: APPROVE_ABI, data: intent.data });
  } catch {
    return { approved: false, failures: ["unsupported-approval-calldata"], call: null };
  }

  const token = getAddress(intent.to);
  const spender = getAddress(call.args[0]);
  const amount = BigInt(call.args[1]);
  const tokenLimit = Object.entries(policy.approvalLimits || {}).find(([address]) =>
    sameAddress(address, token))?.[1];

  if (BigInt(intent.valueWei) !== 0n) failures.push("unexpected-approval-value");
  if (!tokenLimit) failures.push("approval-token-not-allowed");
  if (!(policy.allowedApprovalSpenders || []).some((address) => sameAddress(address, spender))) {
    failures.push("approval-spender-not-allowed");
  }
  if (!expected || !sameAddress(expected.spender, spender)) failures.push("approval-spender-mismatch");
  if (!expected || amount !== BigInt(String(expected.amount))) failures.push("approval-amount-mismatch");
  if (amount === 0n) failures.push("zero-approval");
  if (amount === MAX_UINT256) failures.push("unlimited-approval");
  if (tokenLimit && amount > BigInt(String(tokenLimit.maxAmount))) failures.push("approval-amount-limit");

  return {
    approved: failures.length === 0,
    failures,
    call: { functionName: call.functionName, token, spender, amount },
  };
}

export { APPROVE_ABI, MAX_UINT256 };
