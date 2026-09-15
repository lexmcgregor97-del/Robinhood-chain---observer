const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BLOCK_NUMBER = /^0x[0-9a-fA-F]+$/;
const MINED_FINAL = new Set(["confirmed", "reverted"]);

function minedStatus(receipt) {
  if (!receipt) return null;
  if (receipt.status === "success" || receipt.status === 1 || receipt.status === "0x1") {
    return "confirmed";
  }
  if (receipt.status === "reverted" || receipt.status === 0 || receipt.status === "0x0") {
    return "reverted";
  }
  return null;
}

const ageOf = (record, now) => Math.max(
  0, now - Number(record.updatedAt || record.createdAt || now),
);

export class ExecutionRecovery {
  constructor({ journal, nonceLane, getReceipt, expectedWalletAddress }) {
    if (!journal || !nonceLane || typeof getReceipt !== "function"
        || !ADDRESS.test(String(expectedWalletAddress || ""))) {
      throw new Error("invalid-execution-recovery-config");
    }
    this.journal = journal;
    this.nonceLane = nonceLane;
    this.getReceipt = getReceipt;
    this.expectedWalletAddress = expectedWalletAddress.toLowerCase();
  }

  async finalizeMinedNonceResidue(outcomes) {
    for (const lane of this.nonceLane.snapshot().lanes || []) {
      const intentId = lane.pending?.intentId;
      const record = intentId ? this.journal.get(intentId) : null;
      if (record && MINED_FINAL.has(record.status)) {
        await this.nonceLane.finalize(intentId);
        outcomes.push(Object.freeze({ intentId, outcome: "finalized-nonce-residue",
          status: record.status }));
      }
    }
  }

  async reconcile({ now = Date.now(), manualReviewAfterMs = 10 * 60_000 } = {}) {
    if (!Number.isFinite(Number(now)) || !Number.isFinite(Number(manualReviewAfterMs))
        || Number(manualReviewAfterMs) < 0) {
      throw new Error("invalid-execution-recovery-policy");
    }
    const outcomes = [];
    await this.finalizeMinedNonceResidue(outcomes);
    for (const record of this.journal.pending()) {
      const intentId = record.intentId;
      if (!TX_HASH.test(String(record.transactionHash || ""))) {
        if (record.status !== "manual-review") {
          await this.journal.transition(intentId, { status: "manual-review",
            recoveryFailure: "signed-transaction-not-durable" }, now);
        }
        outcomes.push(Object.freeze({ intentId, outcome: "manual-review",
          failure: "signed-transaction-not-durable" }));
        continue;
      }
      let receipt;
      try {
        receipt = await this.getReceipt(record.transactionHash);
      } catch {
        outcomes.push(Object.freeze({ intentId, outcome: "rpc-error",
          failure: "execution-receipt-read-failed" }));
        continue;
      }
      if (!receipt) {
        if (ageOf(record, Number(now)) >= Number(manualReviewAfterMs)) {
          if (record.status !== "manual-review") {
            await this.journal.transition(intentId, { status: "manual-review",
              recoveryFailure: "execution-receipt-timeout" }, now);
          }
          outcomes.push(Object.freeze({ intentId, outcome: "manual-review",
            failure: "execution-receipt-timeout" }));
        } else {
          outcomes.push(Object.freeze({ intentId, outcome: "still-pending" }));
        }
        continue;
      }
      if (!TX_HASH.test(String(receipt.transactionHash || ""))
          || String(receipt.transactionHash).toLowerCase() !== record.transactionHash.toLowerCase()) {
        outcomes.push(Object.freeze({ intentId, outcome: "rpc-error",
          failure: "execution-receipt-hash-mismatch" }));
        continue;
      }
      if (!ADDRESS.test(String(receipt.from || ""))
          || String(receipt.from).toLowerCase() !== this.expectedWalletAddress) {
        outcomes.push(Object.freeze({ intentId, outcome: "rpc-error",
          failure: "execution-receipt-sender-mismatch" }));
        continue;
      }
      if (!(BLOCK_NUMBER.test(String(receipt.blockNumber || ""))
          || (Number.isSafeInteger(receipt.blockNumber) && receipt.blockNumber >= 0))) {
        outcomes.push(Object.freeze({ intentId, outcome: "rpc-error",
          failure: "execution-receipt-block-invalid" }));
        continue;
      }
      const status = minedStatus(receipt);
      if (!status) {
        outcomes.push(Object.freeze({ intentId, outcome: "rpc-error",
          failure: "execution-receipt-status-invalid" }));
        continue;
      }
      await this.journal.transition(intentId, { status, receipt,
        receiptBlock: receipt.blockNumber }, now);
      await this.nonceLane.finalize(intentId);
      outcomes.push(Object.freeze({ intentId, outcome: "reconciled", status }));
    }
    const counts = outcomes.reduce((result, item) => {
      result[item.outcome] = Number(result[item.outcome] || 0) + 1;
      return result;
    }, {});
    return Object.freeze({
      checkedAt: Number(now), outcomes: Object.freeze(outcomes), counts: Object.freeze(counts),
      pendingExecutions: this.journal.pending().length,
      safeToRestart: !counts["rpc-error"],
    });
  }
}
