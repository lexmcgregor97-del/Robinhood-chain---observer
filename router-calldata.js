import { decodeFunctionData, getAddress, isAddressEqual } from "viem";

const V2_ROUTER_ABI = [
  {
    type: "function", name: "swapExactETHForTokens", stateMutability: "payable",
    inputs: [
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ], outputs: [{ name: "amounts", type: "uint256[]" }],
  },
  {
    type: "function", name: "swapExactTokensForETH", stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ], outputs: [{ name: "amounts", type: "uint256[]" }],
  },
  {
    type: "function", name: "swapExactTokensForTokens", stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ], outputs: [{ name: "amounts", type: "uint256[]" }],
  },
];

const samePath = (left, right) => left.length === right.length
  && left.every((address, index) => isAddressEqual(address, right[index]));

export function validateV2RouterCalldata(intent, policy, { nowSeconds = Math.floor(Date.now() / 1000) } = {}) {
  const failures = [];
  let call;
  try {
    call = decodeFunctionData({ abi: V2_ROUTER_ABI, data: intent.data });
  } catch {
    return { approved: false, failures: ["unsupported-router-calldata"], call: null };
  }

  const args = [...call.args];
  const ethInput = call.functionName === "swapExactETHForTokens";
  const amountIn = ethInput ? BigInt(intent.valueWei) : BigInt(args.shift());
  const amountOutMin = BigInt(args.shift());
  const path = args.shift().map(getAddress);
  const recipient = getAddress(args.shift());
  const deadline = Number(args.shift());
  const allowedPaths = (policy.allowedPaths || []).map((candidate) => candidate.map(getAddress));

  if (amountIn <= 0n) failures.push("invalid-amount-in");
  if (amountOutMin <= 0n) failures.push("zero-minimum-output");
  if (!isAddressEqual(recipient, getAddress(policy.walletAddress))) failures.push("recipient-mismatch");
  if (!allowedPaths.some((candidate) => samePath(path, candidate))) failures.push("path-not-allowed");
  if (!Number.isSafeInteger(deadline) || deadline < nowSeconds) failures.push("router-deadline-expired");
  if (deadline > nowSeconds + Number(policy.maxRouterDeadlineSeconds || 60)) {
    failures.push("router-deadline-too-distant");
  }
  if (ethInput && BigInt(intent.valueWei) !== amountIn) failures.push("transaction-value-mismatch");
  if (!ethInput && BigInt(intent.valueWei) !== 0n) failures.push("unexpected-transaction-value");
  const spendAsset = ethInput ? "native" : path[0].toLowerCase();
  if (intent.spendAsset !== spendAsset) failures.push("spend-asset-mismatch");
  if (BigInt(intent.spendAmount) !== amountIn) failures.push("spend-amount-mismatch");

  return {
    approved: failures.length === 0,
    failures,
    call: { functionName: call.functionName, amountIn, amountOutMin, path, recipient, deadline },
  };
}

export { V2_ROUTER_ABI };
