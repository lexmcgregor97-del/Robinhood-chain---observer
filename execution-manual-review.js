const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

const NEVER_SIGNED_FAILURE = "signed-transaction-not-durable";

export class ExecutionManualReviewResolver {
  constructor({ journal, nonceLane }) {
    if (!journal || !nonceLane) throw new Error("invalid-manual-review-resolver-config");
    this.journal = journal;
    this.nonceLane = nonceLane;
  }

  async rejectNeverSigned(intentId, { now = Date.now(), operatorAssertion } = {}) {
    if (operatorAssertion !== "REJECT_ATLAS_NEVER_SIGNED_RESERVATION") {
      throw new Error("manual-review-operator-assertion-required");
    }
    const record = this.journal.get(String(intentId || ""));
    if (!record || record.status !== "manual-review") {
      throw new Error("manual-review-record-required");
    }
    if (record.recoveryFailure !== NEVER_SIGNED_FAILURE
        || TX_HASH.test(String(record.transactionHash || ""))
        || typeof record.signedPayload === "string") {
      throw new Error("manual-review-never-signed-proof-failed");
    }
    await this.journal.transition(record.intentId, {
      status: "operator-rejected",
      stage: "operator-resolution",
      failures: [NEVER_SIGNED_FAILURE],
      operatorResolution: {
        type: "never-signed-rejection",
        assertedAt: Number(now),
      },
    }, now);
    await this.nonceLane.finalize(record.intentId);
    return Object.freeze({ intentId: record.intentId, status: "operator-rejected",
      resolution: "never-signed-rejection" });
  }
}
