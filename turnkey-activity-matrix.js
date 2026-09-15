import {
  decodeFunctionData, getAddress, isAddressEqual, parseTransaction,
  recoverTransactionAddress,
} from "viem";
import { APPROVE_ABI, MAX_UINT256 } from "./approval-calldata.js";
import { ROBINHOOD } from "./chain-config.js";
import { V2_ROUTER_ABI } from "./router-calldata.js";

export const REQUIRED_DENIAL_CASES = Object.freeze([
  "wrong-chain", "non-zero-value", "foreign-router", "wrong-selector",
  "excessive-input", "zero-minimum-output", "three-token-path",
  "wrong-weth-orientation", "foreign-recipient", "excessive-gas-or-fee",
  "foreign-approval-spender", "approve-max-uint",
]);
const ALLOW_CASES = Object.freeze(["buy", "sell", "approval"]);
const DENIED = new Set(["ACTIVITY_STATUS_FAILED", "ACTIVITY_STATUS_REJECTED"]);

const sameAddress = (left, right) => {
  try { return isAddressEqual(left, right); } catch { return false; }
};
const allowedRouter = (address, config) =>
  (config.allowedRouters || []).some((router) => sameAddress(address, router));
const approvedBy = (activity, userId) => (activity.votes || []).some((vote) =>
  vote?.userId === userId && vote?.selection === "VOTE_SELECTION_APPROVED");
const policyDenied = (activity) => {
  const failure = JSON.stringify(activity?.failure || {});
  return /policy/i.test(failure) && /(denied|deny|rejected|reject)/i.test(failure);
};

function commonTransactionFailures(transaction, config) {
  const failures = [];
  if (transaction.chainId !== ROBINHOOD.chainId) failures.push("matrix-chain-mismatch");
  if (BigInt(transaction.value || 0n) !== 0n) failures.push("matrix-native-value-present");
  if (!transaction.to) failures.push("matrix-transaction-target-missing");
  if (transaction.gas == null || BigInt(transaction.gas) > BigInt(config.maxGas)) {
    failures.push("matrix-gas-bound-unverified");
  }
  if (transaction.maxFeePerGas == null
      || BigInt(transaction.maxFeePerGas) > BigInt(config.maxFeePerGasWei)) {
    failures.push("matrix-fee-bound-unverified");
  }
  if (transaction.maxPriorityFeePerGas == null
      || BigInt(transaction.maxPriorityFeePerGas) > BigInt(config.maxFeePerGasWei)) {
    failures.push("matrix-priority-fee-bound-unverified");
  }
  return failures;
}

function validateAllowedCall(kind, transaction, entry, config) {
  const failures = commonTransactionFailures(transaction, config);
  if (kind === "approval") {
    let call;
    try { call = decodeFunctionData({ abi: APPROVE_ABI, data: transaction.data }); } catch {
      return [...failures, "matrix-approval-calldata-invalid"];
    }
    const [spender, amount] = call.args;
    if (!allowedRouter(spender, config)) failures.push("matrix-approval-spender-invalid");
    if (BigInt(amount) <= 0n || BigInt(amount) === MAX_UINT256) {
      failures.push("matrix-approval-amount-invalid");
    }
    if (!entry.token || !sameAddress(transaction.to, entry.token)) {
      failures.push("matrix-approval-token-mismatch");
    }
    if (!/^[1-9][0-9]*$/.test(String(entry.amount || ""))
        || BigInt(entry.amount) !== BigInt(amount)) failures.push("matrix-approval-amount-mismatch");
    return failures;
  }

  if (!allowedRouter(transaction.to, config)) failures.push("matrix-router-invalid");
  let call;
  try { call = decodeFunctionData({ abi: V2_ROUTER_ABI, data: transaction.data }); } catch {
    return [...failures, "matrix-swap-calldata-invalid"];
  }
  if (call.functionName !== "swapExactTokensForTokens") {
    return [...failures, "matrix-swap-selector-invalid"];
  }
  const [amountIn, amountOutMin, path, recipient] = call.args;
  if (BigInt(amountIn) <= 0n || BigInt(amountOutMin) <= 0n) failures.push("matrix-swap-amount-invalid");
  if (path.length !== 2) failures.push("matrix-swap-path-length-invalid");
  if (!sameAddress(recipient, config.walletAddress)) failures.push("matrix-swap-recipient-invalid");
  if (kind === "buy") {
    if (!sameAddress(path[0], ROBINHOOD.weth)) failures.push("matrix-buy-orientation-invalid");
    if (BigInt(amountIn) > BigInt(config.maxPerTransactionWei)) {
      failures.push("matrix-buy-cap-exceeded");
    }
  } else if (!sameAddress(path[1], ROBINHOOD.weth)) {
    failures.push("matrix-sell-orientation-invalid");
  }
  return failures;
}

async function verifyAllowedActivity(activity, entry, config, signingUserId) {
  const failures = [];
  if (activity?.organizationId !== config.organizationId) failures.push("matrix-organization-mismatch");
  if (activity?.status !== "ACTIVITY_STATUS_COMPLETED") failures.push("matrix-allow-not-completed");
  if (activity?.type !== "ACTIVITY_TYPE_SIGN_TRANSACTION_V2") failures.push("matrix-activity-type-invalid");
  if (!approvedBy(activity, signingUserId)) failures.push("matrix-signing-user-vote-missing");
  const intent = activity?.intent?.signTransactionIntentV2;
  if (!sameAddress(intent?.signWith, config.walletAddress)) failures.push("matrix-signing-wallet-mismatch");
  const signedTransaction = activity?.result?.signTransactionResult?.signedTransaction;
  let transaction;
  try {
    transaction = parseTransaction(signedTransaction);
    const signer = await recoverTransactionAddress({ serializedTransaction: signedTransaction });
    if (!sameAddress(signer, config.walletAddress)) failures.push("matrix-signer-mismatch");
  } catch {
    failures.push("matrix-signed-transaction-invalid");
  }
  if (transaction) failures.push(...validateAllowedCall(entry.case, transaction, entry, config));
  return failures;
}

function verifyDeniedActivity(activity, config, signingUserId) {
  const failures = [];
  if (activity?.organizationId !== config.organizationId) failures.push("matrix-organization-mismatch");
  if (!DENIED.has(activity?.status)) failures.push("matrix-denial-status-invalid");
  if (activity?.type !== "ACTIVITY_TYPE_SIGN_TRANSACTION_V2") failures.push("matrix-activity-type-invalid");
  if (!approvedBy(activity, signingUserId)) failures.push("matrix-signing-user-vote-missing");
  if (!sameAddress(activity?.intent?.signTransactionIntentV2?.signWith, config.walletAddress)) {
    failures.push("matrix-signing-wallet-mismatch");
  }
  if (!policyDenied(activity)) failures.push("matrix-policy-denial-unverified");
  return failures;
}

export async function verifyTurnkeyActivityMatrix({
  matrix, config, signingUserId, getActivity,
} = {}) {
  if (typeof getActivity !== "function") throw new Error("turnkey-get-activity-required");
  const allows = Array.isArray(matrix?.allows) ? matrix.allows : [];
  const denials = Array.isArray(matrix?.denials) ? matrix.denials : [];
  const failures = [];
  if (allows.length !== ALLOW_CASES.length
      || !ALLOW_CASES.every((kind) => allows.some((entry) => entry?.case === kind))) {
    failures.push("behavioral-matrix-allow-cases-incomplete");
  }
  if (denials.length < REQUIRED_DENIAL_CASES.length
      || !REQUIRED_DENIAL_CASES.every((kind) => denials.some((entry) => entry?.case === kind))) {
    failures.push("behavioral-matrix-denial-cases-incomplete");
  }
  const entries = [...allows, ...denials];
  const ids = entries.map((entry) => String(entry?.activityId || ""));
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    failures.push("behavioral-matrix-activity-ids-invalid");
  }
  if (failures.length) return Object.freeze({ verified: false, failures: Object.freeze(failures) });

  try {
    for (const entry of allows) {
      const response = await getActivity({ organizationId: config.organizationId,
        activityId: entry.activityId });
      failures.push(...await verifyAllowedActivity(response?.activity || response,
        entry, config, signingUserId));
    }
    for (const entry of denials) {
      const response = await getActivity({ organizationId: config.organizationId,
        activityId: entry.activityId });
      failures.push(...verifyDeniedActivity(response?.activity || response, config, signingUserId));
    }
  } catch {
    failures.push("behavioral-matrix-activity-read-failed");
  }
  return Object.freeze({ verified: failures.length === 0,
    normalized: failures.length ? null : Object.freeze({ runAt: matrix.runAt,
      allows: Object.freeze(allows.map((entry) => entry.activityId)),
      denials: Object.freeze(denials.map((entry) => entry.activityId)) }),
    failures: Object.freeze([...new Set(failures)]) });
}
