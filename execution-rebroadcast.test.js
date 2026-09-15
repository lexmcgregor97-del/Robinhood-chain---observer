import test from "node:test";
import assert from "node:assert/strict";
import { keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ExecutionJournal } from "./execution-journal.js";
import { NonceLane } from "./nonce-lane.js";
import { ExecutionRebroadcastResolver } from "./execution-rebroadcast.js";

const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const transaction = { chainId: 4663, type: "eip1559", nonce: 7,
  to: "0x2222222222222222222222222222222222222222", data: "0x12345678",
  value: 0n, gas: 150000n, maxFeePerGas: 1000000000n,
  maxPriorityFeePerGas: 1000000n };

async function fixture(record = {}, overrides = {}) {
  const signedPayload = await account.signTransaction(transaction);
  const transactionHash = keccak256(signedPayload);
  const journal = new ExecutionJournal({ transitionCount: 1, records: [{
    intentId: "entry:1", status: "signed", chainId: 4663, nonce: 7,
    signedPayload, transactionHash, createdAt: 1, updatedAt: 2, ...record,
  }] }, overrides.journalOptions);
  const nonceLane = new NonceLane({ mutationCount: 1, lanes: [{
    key: `4663:${account.address.toLowerCase()}`, chainId: 4663,
    walletAddress: account.address.toLowerCase(), nextNonce: 8,
    pending: { intentId: "entry:1", nonce: 7 },
  }] });
  const calls = [];
  return { journal, nonceLane, signedPayload, transactionHash, calls,
    resolver: new ExecutionRebroadcastResolver({ journal, nonceLane,
      expectedWalletAddress: account.address,
      getTransactionCount: async (_address, tag) => overrides[tag] || "0x7",
      broadcastRaw: async (payload) => { calls.push(payload);
        return overrides.returnedHash || transactionHash; } }) };
}

test("checkpoints intent before broadcasting only the identical stored bytes", async () => {
  const events = [];
  let current;
  const item = await fixture({}, { journalOptions: { persist: async (_state, event) => {
    events.push({ status: event.record.status, broadcastCalls: current.calls.length });
  } } });
  current = item;
  const result = await item.resolver.rebroadcastIdentical("entry:1", { now: 10,
    operatorAssertion: "REBROADCAST_ATLAS_IDENTICAL_SIGNED_PAYLOAD" });
  assert.equal(result.status, "broadcast");
  assert.deepEqual(item.calls, [item.signedPayload]);
  assert.deepEqual(events, [{ status: "rebroadcast-requested", broadcastCalls: 0 },
    { status: "broadcast", broadcastCalls: 1 }]);
  assert.notEqual(item.nonceLane.snapshot().lanes[0].pending, null);
});

test("refuses hash, signer, chain, nonce, and lane drift before network send", async () => {
  for (const changed of [
    { transactionHash: `0x${"12".repeat(32)}` },
    { chainId: 1 }, { nonce: 8 },
  ]) {
    const item = await fixture(changed);
    await assert.rejects(item.resolver.rebroadcastIdentical("entry:1", {
      operatorAssertion: "REBROADCAST_ATLAS_IDENTICAL_SIGNED_PAYLOAD" }),
    /execution-rebroadcast-(hash|transaction)-mismatch/);
    assert.equal(item.calls.length, 0);
  }
  const item = await fixture();
  await item.nonceLane.finalize("entry:1");
  await assert.rejects(item.resolver.rebroadcastIdentical("entry:1", {
    operatorAssertion: "REBROADCAST_ATLAS_IDENTICAL_SIGNED_PAYLOAD" }), /nonce-lane-mismatch/);
  assert.equal(item.calls.length, 0);
});

test("a confirmed or pending nonce conflict is journaled and never broadcast", async () => {
  for (const overrides of [{ latest: "0x8" }, { pending: "0x8" }]) {
    const item = await fixture({}, overrides);
    const result = await item.resolver.rebroadcastIdentical("entry:1", { now: 10,
      operatorAssertion: "REBROADCAST_ATLAS_IDENTICAL_SIGNED_PAYLOAD" });
    assert.equal(result.status, "manual-review");
    assert.equal(item.calls.length, 0);
    assert.match(item.journal.get("entry:1").recoveryFailure, /nonce-(consumed|pending)/);
    assert.notEqual(item.nonceLane.snapshot().lanes[0].pending, null);
  }
});

test("a failed pre-broadcast checkpoint prevents the network send", async () => {
  const item = await fixture({}, { journalOptions: { persist: async () => {
    throw new Error("disk-failed");
  } } });
  await assert.rejects(item.resolver.rebroadcastIdentical("entry:1", { now: 10,
    operatorAssertion: "REBROADCAST_ATLAS_IDENTICAL_SIGNED_PAYLOAD" }), /disk-failed/);
  assert.equal(item.calls.length, 0);
  assert.equal(item.journal.get("entry:1").status, "signed");
});

test("a crash-left rebroadcast request can retry the same bytes", async () => {
  const item = await fixture({ status: "rebroadcast-requested" });
  const result = await item.resolver.rebroadcastIdentical("entry:1", {
    operatorAssertion: "REBROADCAST_ATLAS_IDENTICAL_SIGNED_PAYLOAD" });
  assert.equal(result.status, "broadcast");
  assert.deepEqual(item.calls, [item.signedPayload]);
});
