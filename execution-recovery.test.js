import test from "node:test";
import assert from "node:assert/strict";
import { ExecutionJournal } from "./execution-journal.js";
import { NonceLane } from "./nonce-lane.js";
import { ExecutionRecovery } from "./execution-recovery.js";

const wallet = "0x1111111111111111111111111111111111111111";
const hash = `0x${"12".repeat(32)}`;
const now = 1_000_000;

function fixture({ status = "broadcast", transactionHash = hash,
  updatedAt = now - 1_000, receipt = null, getReceipt, recoveryFailure,
  operatorResolution, signingRequestedAt } = {}) {
  const journal = new ExecutionJournal({ transitionCount: 1, records: [{
    intentId: "entry:1", status, transactionHash, chainId: 4663,
    createdAt: updatedAt, updatedAt, recoveryFailure, operatorResolution, signingRequestedAt,
  }] });
  const nonceLane = new NonceLane({ mutationCount: 1, lanes: [{
    key: `4663:${wallet}`, chainId: 4663, walletAddress: wallet, nextNonce: 8,
    pending: { intentId: "entry:1", nonce: 7 },
  }] });
  const recovery = new ExecutionRecovery({ journal, nonceLane, expectedWalletAddress: wallet,
    getReceipt: getReceipt || (async () => receipt) });
  return { journal, nonceLane, recovery };
}

test("reconciles a confirmed receipt and durably releases its nonce", async () => {
  const { journal, nonceLane, recovery } = fixture({ receipt: {
    status: "0x1", transactionHash: hash, from: wallet, blockNumber: "0x10",
  } });
  const result = await recovery.reconcile({ now });
  assert.equal(result.counts.reconciled, 1);
  assert.equal(result.pendingExecutions, 0);
  assert.equal(journal.get("entry:1").status, "confirmed");
  assert.equal(journal.get("entry:1").receiptBlock, "0x10");
  assert.equal(nonceLane.snapshot().lanes[0].pending, null);
});

test("retains a mined revert as a full-loss final outcome", async () => {
  const { journal, recovery } = fixture({ receipt: {
    status: "0x0", transactionHash: hash, from: wallet, blockNumber: "0x10",
  } });
  const result = await recovery.reconcile({ now });
  assert.equal(result.outcomes[0].status, "reverted");
  assert.equal(journal.get("entry:1").status, "reverted");
});

test("keeps a recent transaction pending when no receipt exists", async () => {
  const { journal, nonceLane, recovery } = fixture();
  const result = await recovery.reconcile({ now, manualReviewAfterMs: 10_000 });
  assert.equal(result.outcomes[0].outcome, "still-pending");
  assert.equal(journal.get("entry:1").status, "broadcast");
  assert.notEqual(nonceLane.snapshot().lanes[0].pending, null);
});

test("escalates a stale missing receipt to durable manual review", async () => {
  const { journal, nonceLane, recovery } = fixture({ updatedAt: now - 20_000 });
  const result = await recovery.reconcile({ now, manualReviewAfterMs: 10_000 });
  assert.equal(result.outcomes[0].outcome, "manual-review");
  assert.equal(journal.get("entry:1").status, "manual-review");
  assert.equal(journal.pending().length, 1);
  assert.notEqual(nonceLane.snapshot().lanes[0].pending, null);
});

test("an unsigned reservation is immediately marked for manual review", async () => {
  const { journal, recovery } = fixture({ status: "reserved", transactionHash: null });
  const result = await recovery.reconcile({ now });
  assert.equal(result.outcomes[0].failure, "signed-transaction-not-durable");
  assert.equal(journal.get("entry:1").status, "manual-review");
});

test("a requested signature without durable bytes is marked ambiguous", async () => {
  const { journal, nonceLane, recovery } = fixture({ status: "signing-requested",
    transactionHash: null, signingRequestedAt: now - 1 });
  const result = await recovery.reconcile({ now });
  assert.equal(result.outcomes[0].failure, "manual-review-signing-ambiguous");
  assert.equal(journal.get("entry:1").recoveryFailure, "manual-review-signing-ambiguous");
  assert.notEqual(nonceLane.snapshot().lanes[0].pending, null);
});

test("RPC errors and malformed receipts cannot change durable state", async () => {
  for (const getReceipt of [
    async () => { throw new Error("provider-secret-text"); },
    async () => ({ status: "unknown", transactionHash: hash, from: wallet }),
    async () => ({ status: "0x1", transactionHash: `0x${"34".repeat(32)}`, from: wallet }),
    async () => ({ status: "0x1", transactionHash: hash }),
    async () => ({ status: "0x1", transactionHash: hash,
      from: "0x2222222222222222222222222222222222222222" }),
    async () => ({ status: "0x1", transactionHash: hash, from: wallet }),
  ]) {
    const { journal, nonceLane, recovery } = fixture({ getReceipt });
    const result = await recovery.reconcile({ now });
    assert.equal(result.outcomes[0].outcome, "rpc-error");
    assert.equal(result.safeToRestart, false);
    assert.equal(journal.get("entry:1").status, "broadcast");
    assert.notEqual(nonceLane.snapshot().lanes[0].pending, null);
    assert.doesNotMatch(JSON.stringify(result), /provider-secret-text/);
  }
});

test("cleans a crash-left nonce only for an already mined final record", async () => {
  const { journal, nonceLane, recovery } = fixture({ status: "confirmed" });
  const result = await recovery.reconcile({ now });
  assert.equal(result.outcomes[0].outcome, "finalized-nonce-residue");
  assert.equal(journal.get("entry:1").status, "confirmed");
  assert.equal(nonceLane.snapshot().lanes[0].pending, null);
});

test("cleans crash residue after a durable never-signed operator rejection", async () => {
  const { journal, nonceLane, recovery } = fixture({ status: "operator-rejected",
    recoveryFailure: "signed-transaction-not-durable",
    operatorResolution: { type: "never-signed-rejection", assertedAt: now - 1 },
  });
  const result = await recovery.reconcile({ now });
  assert.equal(result.outcomes[0].outcome, "finalized-nonce-residue");
  assert.equal(journal.get("entry:1").status, "operator-rejected");
  assert.equal(nonceLane.snapshot().lanes[0].pending, null);
});
