const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

const NEVER_SIGNED_FAILURE = "signed-transaction-not-durable";
const NEVER_SIGNED_PROTOCOLS = new Set([2, 3]);

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
    if (!NEVER_SIGNED_PROTOCOLS.has(record.signingProtocolVersion)
        || record.recoveryFailure !== NEVER_SIGNED_FAILURE
        || record.signingRequestedAt != null
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

  async restoreSignedFromTurnkey(intentId, activityEvidence,
    { now = Date.now(), operatorAssertion } = {}) {
    if (operatorAssertion !== "RESTORE_ATLAS_SIGNED_TRANSACTION_FROM_TURNKEY") {
      throw new Error("manual-review-operator-assertion-required");
    }
    const record = this.journal.get(String(intentId || ""));
    if (!record || record.status !== "manual-review"
        || record.recoveryFailure !== "manual-review-signing-ambiguous") {
      throw new Error("manual-review-ambiguous-record-required");
    }
    const verification = await verifyAmbiguousSigningActivity({ record,
      activity: activityEvidence?.activity,
      organizationId: activityEvidence?.organizationId,
      walletAddress: activityEvidence?.walletAddress,
      signingUserId: activityEvidence?.signingUserId,
      maximumActivityDelayMs: activityEvidence?.maximumActivityDelayMs,
      maxGas: activityEvidence?.maxGas,
      maxFeePerGasWei: activityEvidence?.maxFeePerGasWei,
    });
    if (!verification.verified) {
      throw new Error("manual-review-turnkey-evidence-invalid");
    }
    const evidence = verification.evidence;
    await this.journal.transition(record.intentId, {
      status: "signed",
      transactionHash: evidence.transactionHash,
      signedPayload: evidence.signedPayload,
      signedAt: evidence.createdAt,
      turnkeySigningActivityId: evidence.activityId,
      operatorResolution: { type: "turnkey-signed-payload-restored",
        assertedAt: Number(now) },
      recoveryFailure: null,
    }, now);
    return Object.freeze({ intentId: record.intentId, status: "signed",
      transactionHash: evidence.transactionHash,
      resolution: "turnkey-signed-payload-restored" });
  }
}
import { verifyAmbiguousSigningActivity } from "./turnkey-ambiguous-signing-evidence.js";
