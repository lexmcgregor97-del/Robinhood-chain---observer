import test from "node:test";
import assert from "node:assert/strict";
import { keccak256 } from "viem";
import { ExecutionManualReview } from "./execution-manual-review.js";
import { ExecutionJournal } from "./execution-journal.js";
import { NonceLane } from "./nonce-lane.js";

const wallet = "0x1111111111111111111111111111111111111111";
const foreign = "0x2222222222222222222222222222222222222222";
const payload = `0x${"ab".repeat(100)}`;
const hash = keccak256(payload);
const cancelHash = `0x${"34".repeat(32)}`;
const intentId = "entry:1";
const now = 1_000_000;

function fixture(record, overrides = {}) {
  const journal = new ExecutionJournal({ transitionCount: 1,
    records: [{ intentId, status: "manual-review", chainId: 4663,
      createdAt: 1, updatedAt: 1, ...record }] });
  const nonceLane = new NonceLane({ mutationCount: 1, lanes: [{
    key: `4663:${wallet}`, chainId: 4663, walletAddress: wallet, nextNonce: 8,
    pending: { intentId, nonce: 7 },
  }] });
  const resolver = new ExecutionManualReview({ journal, nonceLane,
    expectedWalletAddress: wallet, chainId: 4663,
    broadcast: async () => hash,
    getTransaction: async () => ({ hash: cancelHash, from: wallet, to: wallet,
      nonce: "0x7", value: "0x0", chainId: "0x1237", input: "0x" }),
    getReceipt: async () => ({ transactionHash: cancelHash, from: wallet,
      status: "0x1", blockNumber: "0x64" }),
    ...overrides,
  });
  return { journal, nonceLane, resolver };
}

test("confirmed unsigned resolution cancels the record and releases its nonce", async () => {
  const { journal, nonceLane, resolver } = fixture({
    recoveryFailure: "signed-transaction-not-durable",
  });
  await assert.rejects(resolver.rejectUnsigned(intentId, { confirmation: "wrong", now }),
    /execution-manual-review-confirmation-mismatch/);
  const result = await resolver.rejectUnsigned(intentId, {
    confirmation: `REJECT_UNSIGNED_ATLAS_EXECUTION:${intentId}`, now,
  });
  assert.equal(result.status, "cancelled");
  assert.equal(journal.get(intentId).operatorResolution, "unsigned-reservation-cancelled");
  assert.equal(nonceLane.snapshot().lanes[0].pending, null);
});

test("unsigned resolution refuses any record carrying signed identity", async () => {
  const { journal, nonceLane, resolver } = fixture({
    recoveryFailure: "signed-transaction-not-durable", transactionHash: hash,
  });
  await assert.rejects(resolver.rejectUnsigned(intentId, {
    confirmation: `REJECT_UNSIGNED_ATLAS_EXECUTION:${intentId}`, now,
  }), /execution-record-is-not-unsigned/);
  assert.equal(journal.get(intentId).status, "manual-review");
  assert.notEqual(nonceLane.snapshot().lanes[0].pending, null);
});

test("rebroadcast sends only the persisted bytes and journals the exact returned hash", async () => {
  const broadcasts = [];
  const { journal, nonceLane, resolver } = fixture({
    recoveryFailure: "execution-receipt-timeout", transactionHash: hash,
    signedPayload: payload,
  }, { broadcast: async (bytes) => { broadcasts.push(bytes); return hash; } });
  const result = await resolver.rebroadcastIdentical(intentId, {
    confirmation: `REBROADCAST_ATLAS_EXECUTION:${intentId}:${hash}`, now,
  });
  assert.deepEqual(broadcasts, [payload]);
  assert.equal(result.status, "broadcast");
  assert.equal(journal.get(intentId).operatorResolution, "identical-payload-rebroadcast");
  assert.notEqual(nonceLane.snapshot().lanes[0].pending, null);
});

test("rebroadcast hash mismatch leaves manual review and the nonce intact", async () => {
  const { journal, nonceLane, resolver } = fixture({
    transactionHash: hash, signedPayload: payload,
  }, { broadcast: async () => cancelHash });
  await assert.rejects(resolver.rebroadcastIdentical(intentId, {
    confirmation: `REBROADCAST_ATLAS_EXECUTION:${intentId}:${hash}`, now,
  }), /broadcast-hash-mismatch/);
  assert.equal(journal.get(intentId).status, "manual-review");
  assert.notEqual(nonceLane.snapshot().lanes[0].pending, null);
});

test("a mined zero-value self-cancel proves nonce consumption", async () => {
  const { journal, nonceLane, resolver } = fixture({
    recoveryFailure: "execution-receipt-timeout", transactionHash: hash,
    signedPayload: payload,
  });
  const result = await resolver.proveNonceCancel(intentId, cancelHash, {
    confirmation: `CONFIRM_ATLAS_NONCE_CANCEL:${intentId}:${cancelHash}`, now,
  });
  assert.equal(result.status, "cancelled");
  assert.equal(journal.get(intentId).operatorResolution, "nonce-consumed-by-self-cancel");
  assert.equal(journal.get(intentId).nonceConsumptionReceiptBlock, "0x64");
  assert.equal(nonceLane.snapshot().lanes[0].pending, null);
});

test("foreign, value-bearing, wrong-nonce, and data-bearing replacements fail closed", async () => {
  for (const transaction of [
    { hash: cancelHash, from: foreign, to: wallet, nonce: "0x7",
      value: "0x0", chainId: "0x1237", input: "0x" },
    { hash: cancelHash, from: wallet, to: wallet, nonce: "0x7",
      value: "0x1", chainId: "0x1237", input: "0x" },
    { hash: cancelHash, from: wallet, to: wallet, nonce: "0x8",
      value: "0x0", chainId: "0x1237", input: "0x" },
    { hash: cancelHash, from: wallet, to: wallet, nonce: "0x7",
      value: "0x0", chainId: "0x1237", input: "0x01" },
  ]) {
    const { journal, nonceLane, resolver } = fixture({ transactionHash: hash,
      signedPayload: payload }, { getTransaction: async () => transaction });
    await assert.rejects(resolver.proveNonceCancel(intentId, cancelHash, {
      confirmation: `CONFIRM_ATLAS_NONCE_CANCEL:${intentId}:${cancelHash}`, now,
    }), /execution-nonce-cancel-proof-invalid/);
    assert.equal(journal.get(intentId).status, "manual-review");
    assert.notEqual(nonceLane.snapshot().lanes[0].pending, null);
  }
});
