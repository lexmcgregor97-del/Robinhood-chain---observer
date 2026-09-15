import {
  isAddressEqual, keccak256, parseTransaction, recoverTransactionAddress,
} from "viem";
import { executionIntentTransactionDigest } from "./execution-transaction-digest.js";

const COMPLETED = "ACTIVITY_STATUS_COMPLETED";
const SIGN_TRANSACTION = "ACTIVITY_TYPE_SIGN_TRANSACTION_V2";

const sameAddress = (left, right) => {
  try { return isAddressEqual(left, right); } catch { return false; }
};

const normalizedHex = (value) => {
  if (typeof value !== "string") throw new Error("turnkey-activity-transaction-required");
  const body = /^0x/i.test(value) ? value.slice(2) : value;
  if (!body || body.length % 2 || !/^[0-9a-fA-F]+$/.test(body)) {
    throw new Error("turnkey-activity-transaction-invalid");
  }
  return `0x${body}`;
};

const timestampMs = (value) => {
  const seconds = BigInt(String(value?.seconds ?? "-1"));
  const nanos = BigInt(String(value?.nanos ?? "0"));
  if (seconds < 0n || nanos < 0n || nanos >= 1_000_000_000n) {
    throw new Error("turnkey-activity-time-invalid");
  }
  const millis = seconds * 1000n + nanos / 1_000_000n;
  if (millis > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("turnkey-activity-time-invalid");
  return Number(millis);
};

const sameTransaction = (left, right) => left.chainId === right.chainId
  && left.nonce === right.nonce
  && left.type === right.type
  && sameAddress(left.to, right.to)
  && String(left.data || "0x").toLowerCase() === String(right.data || "0x").toLowerCase()
  && BigInt(left.value || 0n) === BigInt(right.value || 0n)
  && BigInt(left.gas || 0n) === BigInt(right.gas || 0n)
  && BigInt(left.maxFeePerGas || 0n) === BigInt(right.maxFeePerGas || 0n)
  && BigInt(left.maxPriorityFeePerGas || 0n) === BigInt(right.maxPriorityFeePerGas || 0n);

export async function verifyAmbiguousSigningActivity({
  record, activity, organizationId, walletAddress, signingUserId,
  maximumActivityDelayMs = 5 * 60_000, maxGas, maxFeePerGasWei,
} = {}) {
  const failures = [];
  if (record?.status !== "manual-review"
      || record?.recoveryFailure !== "manual-review-signing-ambiguous"
      || record?.signingProtocolVersion !== 3
      || !/^0x[0-9a-fA-F]{64}$/.test(String(record?.intentTransactionDigest || ""))
      || !Number.isSafeInteger(record?.nonce)
      || !Number.isFinite(record?.signingRequestedAt)) {
    failures.push("ambiguous-signing-record-invalid");
  }
  let gasLimit;
  let feeLimit;
  try { gasLimit = BigInt(maxGas); feeLimit = BigInt(maxFeePerGasWei); } catch {}
  if (!organizationId || !walletAddress || !signingUserId || !(gasLimit > 0n) || !(feeLimit > 0n)
      || !Number.isSafeInteger(maximumActivityDelayMs) || maximumActivityDelayMs <= 0) {
    failures.push("ambiguous-signing-evidence-config-invalid");
  }
  if (activity?.organizationId !== organizationId) failures.push("turnkey-activity-organization-mismatch");
  if (activity?.type !== SIGN_TRANSACTION) failures.push("turnkey-activity-type-invalid");
  if (activity?.status !== COMPLETED) failures.push("turnkey-activity-not-completed");
  if (!(activity?.votes || []).some((vote) => vote?.userId === signingUserId
      && vote?.selection === "VOTE_SELECTION_APPROVED")) {
    failures.push("turnkey-activity-signing-user-unverified");
  }
  const intent = activity?.intent?.signTransactionIntentV2;
  if (!sameAddress(intent?.signWith, walletAddress)) failures.push("turnkey-activity-wallet-mismatch");

  let createdAt;
  try {
    createdAt = timestampMs(activity?.createdAt);
    if (Number.isFinite(record?.signingRequestedAt)
        && (createdAt < record.signingRequestedAt
          || createdAt > record.signingRequestedAt + maximumActivityDelayMs)) {
      failures.push("turnkey-activity-outside-signing-window");
    }
  } catch {
    failures.push("turnkey-activity-time-invalid");
  }

  let unsignedTransaction;
  let signedTransaction;
  let payload;
  try {
    unsignedTransaction = parseTransaction(normalizedHex(intent?.unsignedTransaction));
    payload = normalizedHex(activity?.result?.signTransactionResult?.signedTransaction);
    signedTransaction = parseTransaction(payload);
    const signer = await recoverTransactionAddress({ serializedTransaction: payload });
    if (!sameAddress(signer, walletAddress)) failures.push("turnkey-activity-signer-mismatch");
  } catch {
    failures.push("turnkey-activity-transaction-invalid");
  }
  if (unsignedTransaction && signedTransaction) {
    if (!sameTransaction(unsignedTransaction, signedTransaction)) {
      failures.push("turnkey-activity-signed-intent-mismatch");
    }
    if (signedTransaction.chainId !== Number(record?.chainId)
        || signedTransaction.nonce !== Number(record?.nonce)) {
      failures.push("turnkey-activity-record-mismatch");
    }
    let digest;
    try {
      digest = executionIntentTransactionDigest({ chainId: signedTransaction.chainId,
        from: walletAddress, to: signedTransaction.to, data: signedTransaction.data,
        value: signedTransaction.value || 0n });
    } catch {}
    if (digest?.toLowerCase() !== String(record?.intentTransactionDigest || "").toLowerCase()) {
      failures.push("turnkey-activity-intent-mismatch");
    }
    if (signedTransaction.type !== "eip1559"
        || signedTransaction.gas == null || signedTransaction.maxFeePerGas == null
        || signedTransaction.maxPriorityFeePerGas == null
        || typeof gasLimit !== "bigint" || typeof feeLimit !== "bigint"
        || (typeof gasLimit === "bigint" && signedTransaction.gas > gasLimit)
        || (typeof feeLimit === "bigint" && signedTransaction.maxFeePerGas > feeLimit)
        || (typeof feeLimit === "bigint" && signedTransaction.maxPriorityFeePerGas > feeLimit)) {
      failures.push("turnkey-activity-gas-fee-limit");
    }
  }
  const uniqueFailures = [...new Set(failures)];
  return Object.freeze({ verified: uniqueFailures.length === 0,
    failures: Object.freeze(uniqueFailures),
    evidence: uniqueFailures.length ? null : Object.freeze({
      activityId: activity.id, createdAt,
      signedPayload: payload, transactionHash: keccak256(payload),
      chainId: signedTransaction.chainId, nonce: signedTransaction.nonce,
    }) });
}
