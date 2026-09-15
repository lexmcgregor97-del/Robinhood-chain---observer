import test from "node:test";
import assert from "node:assert/strict";
import { ExecutionJournal } from "./execution-journal.js";
import { NonceLane } from "./nonce-lane.js";
import { ExecutionManualReviewResolver } from "./execution-manual-review.js";
import { serializeTransaction } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { executionIntentTransactionDigest } from "./execution-transaction-digest.js";

const wallet = "0x1111111111111111111111111111111111111111";
const signingAccount = privateKeyToAccount(`0x${"11".repeat(32)}`);
const organizationId = "11111111-1111-7111-8111-111111111111";
const signingUserId = "44444444-4444-7444-8444-444444444444";

function fixture(record = {}) {
  const journal = new ExecutionJournal({ transitionCount: 2, records: [{
    intentId: "entry:1", status: "manual-review", chainId: 4663,
    signingProtocolVersion: 2, nonce: 7,
    recoveryFailure: "signed-transaction-not-durable", createdAt: 1, updatedAt: 2,
    ...record,
  }] });
  const nonceLane = new NonceLane({ mutationCount: 1, lanes: [{
    key: `4663:${wallet}`, chainId: 4663, walletAddress: wallet, nextNonce: 8,
    pending: { intentId: "entry:1", nonce: 7 },
  }] });
  return { journal, nonceLane,
    resolver: new ExecutionManualReviewResolver({ journal, nonceLane }) };
}

test("journaled rejection precedes nonce release for a proven never-signed reservation", async () => {
  const events = [];
  let journal;
  let nonceLane;
  const persist = async (_snapshot, event) => {
    events.push({ type: event.type, status: journal?.get("entry:1")?.status,
      pending: nonceLane?.snapshot().lanes[0]?.pending?.intentId || null });
  };
  journal = new ExecutionJournal({ transitionCount: 2, records: [{
    intentId: "entry:1", status: "manual-review", chainId: 4663,
    signingProtocolVersion: 2, nonce: 7,
    recoveryFailure: "signed-transaction-not-durable", createdAt: 1, updatedAt: 2,
  }] }, { persist });
  nonceLane = new NonceLane({ mutationCount: 1, lanes: [{
    key: `4663:${wallet}`, chainId: 4663, walletAddress: wallet, nextNonce: 8,
    pending: { intentId: "entry:1", nonce: 7 },
  }] }, { persist });
  const resolver = new ExecutionManualReviewResolver({ journal, nonceLane });
  const result = await resolver.rejectNeverSigned("entry:1", {
    now: 10, operatorAssertion: "REJECT_ATLAS_NEVER_SIGNED_RESERVATION",
  });
  assert.deepEqual(result, { intentId: "entry:1", status: "operator-rejected",
    resolution: "never-signed-rejection" });
  assert.equal(journal.get("entry:1").operatorResolution.type, "never-signed-rejection");
  assert.equal(nonceLane.snapshot().lanes[0].pending, null);
  assert.deepEqual(events.map(({ type }) => type),
    ["execution-operator-rejected", "execution-nonce-finalized"]);
  assert.deepEqual(events[0], { type: "execution-operator-rejected", status: "operator-rejected",
    pending: "entry:1" });
});

test("refuses rejection without the exact operator assertion", async () => {
  const { resolver } = fixture();
  await assert.rejects(resolver.rejectNeverSigned("entry:1"),
    /manual-review-operator-assertion-required/);
});

test("refuses signed, hashed, and non-manual-review records", async () => {
  for (const record of [
    { transactionHash: `0x${"12".repeat(32)}` },
    { signedPayload: "0x02" },
    { signingRequestedAt: 2 },
    { signingProtocolVersion: 1 },
    { recoveryFailure: "execution-receipt-timeout" },
    { status: "broadcast" },
  ]) {
    const { resolver, nonceLane } = fixture(record);
    await assert.rejects(resolver.rejectNeverSigned("entry:1", {
      operatorAssertion: "REJECT_ATLAS_NEVER_SIGNED_RESERVATION",
    }), /manual-review-(never-signed-proof-failed|record-required)/);
    assert.notEqual(nonceLane.snapshot().lanes[0].pending, null);
  }
});

test("a failed rejection checkpoint leaves the nonce blocked", async () => {
  const { nonceLane } = fixture();
  const journal = new ExecutionJournal({ transitionCount: 2, records: [{
    intentId: "entry:1", status: "manual-review", chainId: 4663,
    signingProtocolVersion: 2, nonce: 7,
    recoveryFailure: "signed-transaction-not-durable", createdAt: 1, updatedAt: 2,
  }] }, { persist: async () => { throw new Error("disk-failed"); } });
  const resolver = new ExecutionManualReviewResolver({ journal, nonceLane });
  await assert.rejects(resolver.rejectNeverSigned("entry:1", {
    operatorAssertion: "REJECT_ATLAS_NEVER_SIGNED_RESERVATION",
  }), /disk-failed/);
  assert.equal(journal.get("entry:1").status, "manual-review");
  assert.notEqual(nonceLane.snapshot().lanes[0].pending, null);
});

test("restores verified Turnkey bytes without releasing or broadcasting the nonce", async () => {
  const signingRequestedAt = 1_000_000;
  const transaction = { chainId: 4663, type: "eip1559", nonce: 7,
    to: "0x2222222222222222222222222222222222222222", data: "0x12345678",
    value: 0n, gas: 150000n, maxFeePerGas: 1000000000n,
    maxPriorityFeePerGas: 1000000n };
  const { journal, nonceLane, resolver } = fixture({ chainId: 4663,
    recoveryFailure: "manual-review-signing-ambiguous", signingRequestedAt,
    signingProtocolVersion: 3,
    intentTransactionDigest: executionIntentTransactionDigest({ chainId: 4663,
      from: signingAccount.address, to: transaction.to, data: transaction.data,
      value: transaction.value }),
  });
  const signedPayload = await signingAccount.signTransaction(transaction);
  const activity = { id: "activity-1", organizationId,
    status: "ACTIVITY_STATUS_COMPLETED", type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
    createdAt: { seconds: "1001", nanos: "0" },
    votes: [{ userId: signingUserId, selection: "VOTE_SELECTION_APPROVED" }],
    intent: { signTransactionIntentV2: { signWith: signingAccount.address,
      unsignedTransaction: serializeTransaction(transaction) } },
    result: { signTransactionResult: { signedTransaction: signedPayload } } };
  const result = await resolver.restoreSignedFromTurnkey("entry:1", {
    activity, organizationId, walletAddress: signingAccount.address, signingUserId,
    maxGas: "200000", maxFeePerGasWei: "2000000000",
  }, { now: 4, operatorAssertion: "RESTORE_ATLAS_SIGNED_TRANSACTION_FROM_TURNKEY" });
  assert.equal(result.status, "signed");
  assert.equal(journal.get("entry:1").signedPayload, signedPayload);
  assert.equal(journal.get("entry:1").turnkeySigningActivityId, "activity-1");
  assert.equal(journal.get("entry:1").recoveryFailure, null);
  assert.equal(nonceLane.snapshot().lanes[0].pending.intentId, "entry:1");
});

test("refuses unverified Turnkey restoration evidence without mutation", async () => {
  const { journal, nonceLane, resolver } = fixture({
    recoveryFailure: "manual-review-signing-ambiguous", signingRequestedAt: 2,
  });
  await assert.rejects(resolver.restoreSignedFromTurnkey("entry:1", {},
  { operatorAssertion: "RESTORE_ATLAS_SIGNED_TRANSACTION_FROM_TURNKEY" }),
  /manual-review-turnkey-evidence-invalid/);
  assert.equal(journal.get("entry:1").status, "manual-review");
  assert.notEqual(nonceLane.snapshot().lanes[0].pending, null);
});
