import test from "node:test";
import assert from "node:assert/strict";
import { serializeTransaction } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { executionIntentTransactionDigest } from "./execution-transaction-digest.js";
import {
  findUniqueAmbiguousSigningActivity, restoreUniqueAmbiguousSigningActivity,
} from "./turnkey-ambiguous-signing-recovery.js";

const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const organizationId = "11111111-1111-7111-8111-111111111111";
const signingUserId = "44444444-4444-7444-8444-444444444444";
const requestedAt = 1_000_000;
const intended = { chainId: 4663, type: "eip1559", nonce: 7,
  to: "0x2222222222222222222222222222222222222222", data: "0x12345678",
  value: 0n, gas: 150000n, maxFeePerGas: 1000000000n,
  maxPriorityFeePerGas: 1000000n };
const record = { intentId: "entry:1", status: "manual-review", chainId: 4663, nonce: 7,
  signingProtocolVersion: 3, signingRequestedAt: requestedAt,
  recoveryFailure: "manual-review-signing-ambiguous",
  intentTransactionDigest: executionIntentTransactionDigest({ ...intended,
    from: account.address }) };
const evidenceConfig = { organizationId, walletAddress: account.address, signingUserId,
  maxGas: "200000", maxFeePerGasWei: "2000000000" };

async function activity(id, transaction = intended, at = 1_001_000) {
  const signedTransaction = await account.signTransaction(transaction);
  return { id, organizationId, status: "ACTIVITY_STATUS_COMPLETED",
    type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
    createdAt: { seconds: String(Math.floor(at / 1000)), nanos: "0" },
    votes: [{ userId: signingUserId, selection: "VOTE_SELECTION_APPROVED" }],
    intent: { signTransactionIntentV2: { signWith: account.address,
      unsignedTransaction: serializeTransaction(transaction) } },
    result: { signTransactionResult: { signedTransaction } } };
}

test("filters by the intent digest before selecting one candidate", async () => {
  const exact = await activity("exact");
  const unrelated = await activity("unrelated", { ...intended, data: "0xdeadbeef" }, 1_002_000);
  const selected = await findUniqueAmbiguousSigningActivity({ record, evidenceConfig,
    getActivities: async () => ({ activities: [unrelated, exact] }) });
  assert.deepEqual(selected, { activityId: "exact", scannedActivityCount: 2 });
});

test("refuses zero or multiple digest-matching candidates", async () => {
  const exactA = await activity("exact-a", intended, 1_002_000);
  const exactB = await activity("exact-b", intended, 1_001_000);
  await assert.rejects(findUniqueAmbiguousSigningActivity({ record, evidenceConfig,
    getActivities: async () => ({ activities: [] }) }), /candidate-not-found/);
  await assert.rejects(findUniqueAmbiguousSigningActivity({ record, evidenceConfig,
    getActivities: async () => ({ activities: [exactA, exactB] }) }), /candidate-ambiguous/);
});

test("paginates newest-first until the complete signing window is covered", async () => {
  const exact = await activity("exact", intended, 1_001_000);
  const newer = await activity("newer", { ...intended, nonce: 8 }, 1_003_000);
  const older = await activity("older", { ...intended, nonce: 6 }, 999_000);
  const calls = [];
  const selected = await findUniqueAmbiguousSigningActivity({ record, evidenceConfig,
    pageLimit: 2, getActivities: async (request) => {
      calls.push(request);
      return { activities: request.paginationOptions.before ? [older] : [newer, exact] };
    } });
  assert.equal(selected.activityId, "exact");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].paginationOptions.before, "exact");
});

test("re-fetches the selected activity by ID before resolver mutation", async () => {
  const listed = await activity("exact");
  const refreshed = structuredClone(listed);
  let resolvedActivity;
  const result = await restoreUniqueAmbiguousSigningActivity({ record, evidenceConfig,
    getActivities: async () => ({ activities: [listed] }),
    getActivity: async (request) => {
      assert.equal(request.activityId, "exact");
      return { activity: refreshed };
    },
    resolver: { restoreSignedFromTurnkey: async (_intentId, evidence) => {
      resolvedActivity = evidence.activity;
      return { intentId: "entry:1", status: "signed", transactionHash: "0xhash" };
    } },
    operatorAssertion: "RESTORE_ATLAS_SIGNED_TRANSACTION_FROM_TURNKEY", now: 4,
  });
  assert.equal(resolvedActivity, refreshed);
  assert.equal(result.activityId, "exact");
});

test("refuses malformed ordering, duplicate pages, and activity-ID drift", async () => {
  const first = await activity("first", intended, 1_001_000);
  const later = await activity("later", intended, 1_002_000);
  await assert.rejects(findUniqueAmbiguousSigningActivity({ record, evidenceConfig,
    getActivities: async () => ({ activities: [first, later] }) }), /order-invalid/);
  await assert.rejects(findUniqueAmbiguousSigningActivity({ record, evidenceConfig,
    pageLimit: 1, maxPages: 2, getActivities: async () => ({ activities: [first] }) }),
  /page-invalid/);
  await assert.rejects(restoreUniqueAmbiguousSigningActivity({ record, evidenceConfig,
    getActivities: async () => ({ activities: [first] }),
    getActivity: async () => ({ activity: { ...first, id: "different" } }),
    resolver: {}, operatorAssertion: "RESTORE_ATLAS_SIGNED_TRANSACTION_FROM_TURNKEY" }),
  /refetch-mismatch/);
});
