import {
  isAddressEqual, keccak256, parseTransaction, recoverTransactionAddress,
} from "viem";

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const ELIGIBLE = new Set(["signed", "broadcast", "rebroadcast-requested"]);

const quantity = (value) => {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) {
    throw new Error("execution-rebroadcast-nonce-read-invalid");
  }
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("execution-rebroadcast-nonce-read-invalid");
  }
  return Number(parsed);
};

export class ExecutionRebroadcastResolver {
  constructor({ journal, nonceLane, expectedWalletAddress, getTransactionCount, broadcastRaw }) {
    if (!journal || !nonceLane || typeof getTransactionCount !== "function"
        || typeof broadcastRaw !== "function"
        || !/^0x[0-9a-fA-F]{40}$/.test(String(expectedWalletAddress || ""))) {
      throw new Error("invalid-execution-rebroadcast-config");
    }
    this.journal = journal;
    this.nonceLane = nonceLane;
    this.expectedWalletAddress = expectedWalletAddress.toLowerCase();
    this.getTransactionCount = getTransactionCount;
    this.broadcastRaw = broadcastRaw;
  }

  async rebroadcastIdentical(intentId, { now = Date.now(), operatorAssertion } = {}) {
    if (operatorAssertion !== "REBROADCAST_ATLAS_IDENTICAL_SIGNED_PAYLOAD") {
      throw new Error("execution-rebroadcast-operator-assertion-required");
    }
    let record = this.journal.get(String(intentId || ""));
    const timeoutReview = record?.status === "manual-review"
      && record?.recoveryFailure === "execution-receipt-timeout";
    if (!record || (!ELIGIBLE.has(record.status) && !timeoutReview)
        || typeof record.signedPayload !== "string"
        || !TX_HASH.test(String(record.transactionHash || ""))) {
      throw new Error("execution-rebroadcast-record-ineligible");
    }
    const derivedHash = keccak256(record.signedPayload).toLowerCase();
    if (derivedHash !== record.transactionHash.toLowerCase()) {
      throw new Error("execution-rebroadcast-hash-mismatch");
    }
    let transaction;
    let signer;
    try {
      transaction = parseTransaction(record.signedPayload);
      signer = await recoverTransactionAddress({ serializedTransaction: record.signedPayload });
    } catch {
      throw new Error("execution-rebroadcast-payload-invalid");
    }
    if (!isAddressEqual(signer, this.expectedWalletAddress)
        || transaction.chainId !== Number(record.chainId)
        || transaction.nonce !== Number(record.nonce)) {
      throw new Error("execution-rebroadcast-transaction-mismatch");
    }
    const lane = (this.nonceLane.snapshot().lanes || []).find((item) =>
      item?.pending?.intentId === record.intentId);
    if (!lane || Number(lane.chainId) !== Number(record.chainId)
        || String(lane.walletAddress || "").toLowerCase() !== this.expectedWalletAddress
        || Number(lane.pending?.nonce) !== Number(record.nonce)) {
      throw new Error("execution-rebroadcast-nonce-lane-mismatch");
    }
    const [latest, pending] = await Promise.all([
      this.getTransactionCount(this.expectedWalletAddress, "latest"),
      this.getTransactionCount(this.expectedWalletAddress, "pending"),
    ]).then((values) => values.map(quantity));
    if (latest > record.nonce || pending > record.nonce) {
      const failure = latest > record.nonce
        ? "execution-nonce-consumed-without-receipt" : "execution-nonce-pending-conflict";
      await this.journal.transition(record.intentId, { status: "manual-review",
        recoveryFailure: failure, operatorResolution: { type: "rebroadcast-refused-nonce-conflict",
          assertedAt: Number(now), latestNonce: latest, pendingNonce: pending,
          transactionHash: derivedHash } }, now);
      return Object.freeze({ intentId: record.intentId, status: "manual-review", failure,
        transactionHash: derivedHash });
    }
    if (record.status !== "rebroadcast-requested") {
      record = await this.journal.transition(record.intentId, {
        status: "rebroadcast-requested", recoveryFailure: null,
        rebroadcastRequestedAt: Number(now), operatorResolution: {
          type: "identical-payload-rebroadcast-requested", assertedAt: Number(now),
          transactionHash: derivedHash, latestNonce: latest, pendingNonce: pending,
        } }, now);
    }
    const returnedHash = String(await this.broadcastRaw(record.signedPayload)).toLowerCase();
    if (returnedHash !== derivedHash) throw new Error("execution-rebroadcast-returned-hash-mismatch");
    await this.journal.transition(record.intentId, { status: "broadcast", recoveryFailure: null,
      manuallyRebroadcastAt: Number(now), operatorResolution: {
        type: "identical-payload-rebroadcast", assertedAt: Number(now),
        transactionHash: derivedHash, latestNonce: latest, pendingNonce: pending,
      } }, now);
    return Object.freeze({ intentId: record.intentId, status: "broadcast",
      transactionHash: derivedHash });
  }
}
