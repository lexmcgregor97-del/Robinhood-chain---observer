import {
  decodeFunctionData, getAddress, isAddressEqual, parseTransaction,
  recoverTransactionAddress, toFunctionSelector,
} from "viem";
import { APPROVE_ABI, MAX_UINT256 } from "./approval-calldata.js";
import { ROBINHOOD } from "./chain-config.js";
import { V2_ROUTER_ABI } from "./router-calldata.js";

export const REQUIRED_DENIAL_CASES = Object.freeze([
  "wrong-chain", "non-zero-value", "foreign-router", "wrong-selector",
  "excessive-input", "zero-minimum-output", "three-token-path",
  "wrong-weth-orientation", "foreign-recipient", "excessive-gas-or-fee",
  "excessive-fee",
  "foreign-approval-spender", "approve-max-uint",
]);
const ALLOW_CASES = Object.freeze(["buy", "sell", "approval", "approval-reset"]);
const DENIED = new Set(["ACTIVITY_STATUS_FAILED", "ACTIVITY_STATUS_REJECTED"]);
const SWAP_SELECTOR = toFunctionSelector(
  "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)",
);

const sameAddress = (left, right) => {
  try { return isAddressEqual(left, right); } catch { return false; }
};
const allowedRouter = (address, config) =>
  (config.allowedRouters || []).some((router) => sameAddress(address, router));
const approvedBy = (activity, userId) => (activity.votes || []).some((vote) =>
  vote?.userId === userId && vote?.selection === "VOTE_SELECTION_APPROVED");
const policyDenied = (activity) => {
  // Turnkey's exported policy rejections currently carry a null `failure`.
  // A terminal REJECTED status plus this signing user's approved vote is the
  // policy-engine outcome; FAILED activities still require explicit policy
  // failure evidence.
  if (activity?.status === "ACTIVITY_STATUS_REJECTED" && activity?.failure == null) return true;
  const failure = JSON.stringify(activity?.failure || {});
  return /policy/i.test(failure) && /(denied|deny|rejected|reject)/i.test(failure);
};

function normalizedSerializedTransaction(value) {
  if (typeof value !== "string") throw new Error("serialized-transaction-required");
  const body = /^0x/i.test(value) ? value.slice(2) : value;
  if (!body || body.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(body)) {
    throw new Error("serialized-transaction-invalid");
  }
  return `0x${body}`;
}

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

function signedTransactionMatchesIntent(transaction, unsignedTransaction) {
  let intent;
  try { intent = parseTransaction(normalizedSerializedTransaction(unsignedTransaction)); } catch {
    return false;
  }
  const bigintEqual = (left, right) => left != null && right != null
    && BigInt(left) === BigInt(right);
  return transaction.chainId === intent.chainId
    && transaction.nonce === intent.nonce
    && sameAddress(transaction.to, intent.to)
    && String(transaction.data || "0x").toLowerCase()
      === String(intent.data || "0x").toLowerCase()
    && bigintEqual(transaction.value ?? 0n, intent.value ?? 0n)
    && bigintEqual(transaction.gas, intent.gas)
    && bigintEqual(transaction.maxFeePerGas, intent.maxFeePerGas)
    && bigintEqual(transaction.maxPriorityFeePerGas, intent.maxPriorityFeePerGas);
}

function validateAllowedCall(kind, transaction, entry, config) {
  const failures = commonTransactionFailures(transaction, config);
  if (kind === "approval" || kind === "approval-reset") {
    let call;
    try { call = decodeFunctionData({ abi: APPROVE_ABI, data: transaction.data }); } catch {
      return [...failures, "matrix-approval-calldata-invalid"];
    }
    const [spender, amount] = call.args;
    if (!allowedRouter(spender, config)) failures.push("matrix-approval-spender-invalid");
    if ((kind === "approval" && BigInt(amount) <= 0n)
        || (kind === "approval-reset" && BigInt(amount) !== 0n)
        || BigInt(amount) === MAX_UINT256) {
      failures.push("matrix-approval-amount-invalid");
    }
    if (!entry.token || !sameAddress(transaction.to, entry.token)) {
      failures.push("matrix-approval-token-mismatch");
    }
    const amountPattern = kind === "approval-reset" ? /^0$/ : /^[1-9][0-9]*$/;
    if (!amountPattern.test(String(entry.amount ?? ""))
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
    const serialized = normalizedSerializedTransaction(signedTransaction);
    transaction = parseTransaction(serialized);
    const signer = await recoverTransactionAddress({ serializedTransaction: serialized });
    if (!sameAddress(signer, config.walletAddress)) failures.push("matrix-signer-mismatch");
  } catch {
    failures.push("matrix-signed-transaction-invalid");
  }
  if (transaction) {
    if (!signedTransactionMatchesIntent(transaction, intent?.unsignedTransaction)) {
      failures.push("matrix-signed-transaction-mismatch");
    }
    failures.push(...validateAllowedCall(entry.case, transaction, entry, config));
  }
  return failures;
}

export async function verifyTurnkeyAllowedActivity({
  activity, entry, config, signingUserId,
} = {}) {
  if (!entry || !ALLOW_CASES.includes(entry.case)) {
    return Object.freeze({ verified: false,
      failures: Object.freeze(["matrix-allow-case-invalid"]) });
  }
  const failures = await verifyAllowedActivity(activity?.activity || activity,
    entry, config, signingUserId);
  return Object.freeze({ verified: failures.length === 0,
    failures: Object.freeze([...new Set(failures)]) });
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

function commonDenialDeviations(transaction, config, { routerTarget = true } = {}) {
  const deviations = [];
  if (transaction.chainId !== ROBINHOOD.chainId) deviations.push("wrong-chain");
  if (BigInt(transaction.value || 0n) > 0n) deviations.push("non-zero-value");
  if (routerTarget && !allowedRouter(transaction.to, config)) deviations.push("foreign-router");
  if (transaction.gas == null || BigInt(transaction.gas) > BigInt(config.maxGas)) {
    deviations.push("excessive-gas-or-fee");
  }
  if (transaction.maxFeePerGas == null
      || BigInt(transaction.maxFeePerGas) > BigInt(config.maxFeePerGasWei)
      || transaction.maxPriorityFeePerGas == null
      || BigInt(transaction.maxPriorityFeePerGas) > BigInt(config.maxFeePerGasWei)) {
    deviations.push("excessive-fee");
  }
  return deviations;
}

function buyDenialDeviations(transaction, config) {
  const deviations = commonDenialDeviations(transaction, config);
  const data = String(transaction.data || "0x");
  const selectorMatches = data.slice(0, 10).toLowerCase() === SWAP_SELECTOR.toLowerCase();
  if (!selectorMatches) deviations.push("wrong-selector");
  let call;
  try {
    const normalizedData = selectorMatches ? data : `${SWAP_SELECTOR}${data.slice(10)}`;
    call = decodeFunctionData({ abi: V2_ROUTER_ABI, data: normalizedData });
  } catch {
    deviations.push("malformed-swap-calldata");
    return deviations;
  }
  const [amountIn, amountOutMin, path, recipient] = call.args;
  if (BigInt(amountIn) <= 0n) deviations.push("invalid-input");
  if (BigInt(amountIn) > BigInt(config.maxPerTransactionWei)) deviations.push("excessive-input");
  if (BigInt(amountOutMin) === 0n) deviations.push("zero-minimum-output");
  else if (BigInt(amountOutMin) < 0n) deviations.push("invalid-minimum-output");
  if (path.length === 3) deviations.push("three-token-path");
  else if (path.length !== 2) deviations.push("invalid-path-length");
  if (!sameAddress(path[0], ROBINHOOD.weth)) {
    deviations.push(path.length === 2 && sameAddress(path[1], ROBINHOOD.weth)
      ? "allowed-sell-orientation" : "wrong-weth-orientation");
  }
  if (!sameAddress(recipient, config.walletAddress)) deviations.push("foreign-recipient");
  return deviations;
}

function approvalDenialDeviations(transaction, config) {
  const deviations = commonDenialDeviations(transaction, config, { routerTarget: false });
  let call;
  try { call = decodeFunctionData({ abi: APPROVE_ABI, data: transaction.data }); } catch {
    deviations.push("malformed-approval-calldata");
    return deviations;
  }
  const [spender, amount] = call.args;
  if (!allowedRouter(spender, config)) deviations.push("foreign-approval-spender");
  if (BigInt(amount) === MAX_UINT256) deviations.push("approve-max-uint");
  else if (BigInt(amount) <= 0n) deviations.push("invalid-approval-amount");
  return deviations;
}

function verifyDeniedCase(activity, expectedCase, config) {
  let transaction;
  try {
    const serialized = normalizedSerializedTransaction(
      activity?.intent?.signTransactionIntentV2?.unsignedTransaction,
    );
    transaction = parseTransaction(serialized);
  } catch {
    return ["matrix-denied-transaction-invalid"];
  }
  const approvalCase = new Set(["foreign-approval-spender", "approve-max-uint"])
    .has(expectedCase);
  const deviations = approvalCase
    ? approvalDenialDeviations(transaction, config)
    : buyDenialDeviations(transaction, config);
  return deviations.length === 1 && deviations[0] === expectedCase
    ? [] : ["matrix-denial-case-mismatch"];
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
      const activity = response?.activity || response;
      failures.push(...verifyDeniedActivity(activity, config, signingUserId));
      failures.push(...verifyDeniedCase(activity, entry.case, config));
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
