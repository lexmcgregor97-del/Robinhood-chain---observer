import { keccak256 } from "viem";

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_QUANTITY = /^0x[0-9a-fA-F]+$/;

const quantity = (value) => {
  if (Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && HEX_QUANTITY.test(value)) return BigInt(value);
  throw new Error("invalid-transaction-quantity");
};

const expectedConfirmation = (action, intentId, hash = "") => [
  action, intentId, hash,
].filter(Boolean).join(":");

const durableSignedIdentity = (record) => {
  const transactionHash = String(record?.transactionHash || "").toLowerCase();
  try {
    if (TX_HASH.test(transactionHash) && typeof record?.signedPayload === "string"
        && keccak256(record.signedPayload).toLowerCase() === transactionHash) {
      return { transactionHash, signedPayload: record.signedPayload };
    }
  } catch {}
  return null;
};

export class ExecutionManualReview {
  constructor({ journal, nonceLane, expectedWalletAddress, chainId,
    broadcast, getTransaction, getReceipt }) {
    if (!journal || !nonceLane || !ADDRESS.test(String(expectedWalletAddress || ""))
        || !Number.isSafeInteger(chainId) || chainId <= 0
        || typeof broadcast !== "function" || typeof getTransaction !== "function"
        || typeof getReceipt !== "function") {
      throw new Error("invalid-execution-manual-review-config");
    }
    this.journal = journal;
    this.nonceLane = nonceLane;
    this.wallet = expectedWalletAddress.toLowerCase();
    this.chainId = chainId;
    this.broadcast = broadcast;
    this.getTransaction = getTransaction;
    this.getReceipt = getReceipt;
  }

  requireManualReview(intentId) {
    const record = this.journal.get(String(intentId || ""));
    if (!record || record.status !== "manual-review") {
      throw new Error("execution-manual-review-record-required");
    }
    return record;
  }

  async rejectUnsigned(intentId, { confirmation, now = Date.now() } = {}) {
    const record = this.requireManualReview(intentId);
    if (confirmation !== expectedConfirmation("REJECT_UNSIGNED_ATLAS_EXECUTION", intentId)) {
      throw new Error("execution-manual-review-confirmation-mismatch");
    }
    if (record.recoveryFailure !== "signed-transaction-not-durable"
        || record.transactionHash || record.signedPayload) {
      throw new Error("execution-record-is-not-unsigned");
    }
    await this.journal.transition(intentId, { status: "cancelled",
      operatorResolution: "unsigned-reservation-cancelled", operatorResolvedAt: Number(now),
    }, now);
    await this.nonceLane.finalize(intentId);
    return Object.freeze({ intentId, status: "cancelled",
      resolution: "unsigned-reservation-cancelled" });
  }

  async rebroadcastIdentical(intentId, { confirmation, now = Date.now() } = {}) {
    const record = this.requireManualReview(intentId);
    const signed = durableSignedIdentity(record);
    if (!signed) throw new Error("signed-payload-not-rebroadcastable");
    const { transactionHash } = signed;
    if (confirmation !== expectedConfirmation(
      "REBROADCAST_ATLAS_EXECUTION", intentId, transactionHash,
    )) throw new Error("execution-manual-review-confirmation-mismatch");
    let returnedHash;
    try {
      returnedHash = String(await this.broadcast(signed.signedPayload)).toLowerCase();
    } catch {
      throw new Error("execution-identical-rebroadcast-failed");
    }
    if (returnedHash !== transactionHash) throw new Error("broadcast-hash-mismatch");
    await this.journal.transition(intentId, { status: "broadcast",
      operatorResolution: "identical-payload-rebroadcast",
      manuallyRebroadcastAt: Number(now) }, now);
    return Object.freeze({ intentId, status: "broadcast", transactionHash,
      resolution: "identical-payload-rebroadcast" });
  }

  async proveNonceCancel(intentId, replacementHash, { confirmation, now = Date.now() } = {}) {
    const record = this.requireManualReview(intentId);
    if (!durableSignedIdentity(record)) throw new Error("execution-record-is-not-signed");
    const hash = String(replacementHash || "").toLowerCase();
    if (!TX_HASH.test(hash) || hash === String(record.transactionHash || "").toLowerCase()) {
      throw new Error("replacement-transaction-hash-invalid");
    }
    if (confirmation !== expectedConfirmation(
      "CONFIRM_ATLAS_NONCE_CANCEL", intentId, hash,
    )) throw new Error("execution-manual-review-confirmation-mismatch");
    const lane = (this.nonceLane.snapshot().lanes || [])
      .find((item) => item.pending?.intentId === intentId);
    if (!lane) throw new Error("execution-pending-nonce-required");
    let transaction;
    let receipt;
    try {
      [transaction, receipt] = await Promise.all([
        this.getTransaction(hash), this.getReceipt(hash),
      ]);
    } catch {
      throw new Error("execution-nonce-cancel-proof-read-failed");
    }
    let proofValid = false;
    try {
      proofValid = Boolean(transaction && receipt
        && String(transaction.hash || "").toLowerCase() === hash
        && String(receipt.transactionHash || "").toLowerCase() === hash
        && String(transaction.from || "").toLowerCase() === this.wallet
        && String(receipt.from || "").toLowerCase() === this.wallet
        && String(transaction.to || "").toLowerCase() === this.wallet
        && quantity(transaction.nonce) === BigInt(lane.pending.nonce)
        && quantity(transaction.value) === 0n
        && quantity(transaction.chainId) === BigInt(this.chainId)
        && new Set(["0x", "0x0", "0x00"]).has(String(transaction.input || "").toLowerCase())
        && new Set(["0x0", "0x1", 0, 1, "success", "reverted"]).has(receipt.status)
        && (HEX_QUANTITY.test(String(receipt.blockNumber || ""))
          || (Number.isSafeInteger(receipt.blockNumber) && receipt.blockNumber >= 0)));
    } catch {}
    if (!proofValid) {
      throw new Error("execution-nonce-cancel-proof-invalid");
    }
    await this.journal.transition(intentId, { status: "cancelled",
      operatorResolution: "nonce-consumed-by-self-cancel", operatorResolvedAt: Number(now),
      nonceConsumedByTransactionHash: hash, nonceConsumptionReceiptBlock: receipt.blockNumber,
    }, now);
    await this.nonceLane.finalize(intentId);
    return Object.freeze({ intentId, status: "cancelled",
      resolution: "nonce-consumed-by-self-cancel", replacementTransactionHash: hash });
  }
}
