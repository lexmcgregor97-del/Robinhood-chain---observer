import test from "node:test";
import assert from "node:assert/strict";
import { ExecutionJournal } from "./execution-journal.js";
import { NonceLane } from "./nonce-lane.js";
import { ExecutionManualReviewResolver } from "./execution-manual-review.js";

const wallet = "0x1111111111111111111111111111111111111111";

function fixture(record = {}) {
  const journal = new ExecutionJournal({ transitionCount: 2, records: [{
    intentId: "entry:1", status: "manual-review", chainId: 4663,
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
    ["execution-transition", "execution-nonce-finalized"]);
  assert.deepEqual(events[0], { type: "execution-transition", status: "operator-rejected",
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
    recoveryFailure: "signed-transaction-not-durable", createdAt: 1, updatedAt: 2,
  }] }, { persist: async () => { throw new Error("disk-failed"); } });
  const resolver = new ExecutionManualReviewResolver({ journal, nonceLane });
  await assert.rejects(resolver.rejectNeverSigned("entry:1", {
    operatorAssertion: "REJECT_ATLAS_NEVER_SIGNED_RESERVATION",
  }), /disk-failed/);
  assert.equal(journal.get("entry:1").status, "manual-review");
  assert.notEqual(nonceLane.snapshot().lanes[0].pending, null);
});
