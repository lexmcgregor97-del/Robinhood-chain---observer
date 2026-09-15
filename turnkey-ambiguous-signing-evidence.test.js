import test from "node:test";
import assert from "node:assert/strict";
import { serializeTransaction } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { verifyAmbiguousSigningActivity } from "./turnkey-ambiguous-signing-evidence.js";
import { executionIntentTransactionDigest } from "./execution-transaction-digest.js";

const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const organizationId = "11111111-1111-7111-8111-111111111111";
const signingUserId = "44444444-4444-7444-8444-444444444444";
const to = "0x2222222222222222222222222222222222222222";
const signingRequestedAt = 1_000_000;
const transaction = { chainId: 4663, type: "eip1559", to, data: "0x12345678",
  value: 0n, nonce: 7, gas: 150000n, maxFeePerGas: 1000000000n,
  maxPriorityFeePerGas: 1000000n };

const record = { intentId: "entry:1", status: "manual-review",
  recoveryFailure: "manual-review-signing-ambiguous", signingProtocolVersion: 3,
  signingRequestedAt, chainId: 4663, nonce: 7,
  intentTransactionDigest: executionIntentTransactionDigest({ chainId: 4663,
    from: account.address, to, data: transaction.data, value: transaction.value }) };

const evidenceConfig = { organizationId, walletAddress: account.address, signingUserId,
  maxGas: "200000", maxFeePerGasWei: "2000000000" };

async function fixture() {
  const signedTransaction = await account.signTransaction(transaction);
  return { signedTransaction, activity: {
    id: "activity-1", organizationId, status: "ACTIVITY_STATUS_COMPLETED",
    type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
    createdAt: { seconds: "1001", nanos: "0" },
    votes: [{ userId: signingUserId, selection: "VOTE_SELECTION_APPROVED" }],
    intent: { signTransactionIntentV2: { signWith: account.address,
      unsignedTransaction: serializeTransaction(transaction) } },
    result: { signTransactionResult: { signedTransaction } },
  } };
}

test("verifies one exact completed Turnkey signature for the blocked nonce", async () => {
  const { activity, signedTransaction } = await fixture();
  const result = await verifyAmbiguousSigningActivity({ record, activity,
    ...evidenceConfig });
  assert.equal(result.verified, true);
  assert.equal(result.evidence.signedPayload, signedTransaction);
  assert.equal(result.evidence.nonce, 7);
  assert.equal(result.evidence.chainId, 4663);
});

test("fails closed on identity, time, nonce, intent, signer, and status drift", async () => {
  const { activity } = await fixture();
  const cases = [
    { activity: { ...activity, organizationId: "wrong" } },
    { activity: { ...activity, status: "ACTIVITY_STATUS_FAILED" } },
    { activity: { ...activity, createdAt: { seconds: "2000", nanos: "0" } } },
    { record: { ...record, nonce: 8 } },
    { activity: { ...activity, votes: [] } },
    { activity: { ...activity, intent: { signTransactionIntentV2: {
      ...activity.intent.signTransactionIntentV2, signWith: to } } } },
  ];
  for (const changed of cases) {
    const result = await verifyAmbiguousSigningActivity({
      record: changed.record || record, activity: changed.activity || activity,
      ...evidenceConfig,
    });
    assert.equal(result.verified, false);
    assert.ok(result.failures.length > 0);
  }
});

test("rejects a signed result that differs from the Turnkey unsigned intent", async () => {
  const { activity } = await fixture();
  const changed = await account.signTransaction({ ...transaction, data: "0xdeadbeef" });
  const result = await verifyAmbiguousSigningActivity({ record,
    activity: { ...activity, result: { signTransactionResult: { signedTransaction: changed } } },
    ...evidenceConfig });
  assert.equal(result.verified, false);
  assert.ok(result.failures.includes("turnkey-activity-signed-intent-mismatch"));
});

test("rejects a different genuine wallet transaction with the same chain and nonce", async () => {
  const wrongTransaction = { ...transaction, to: account.address, data: "0xdeadbeef" };
  const signedTransaction = await account.signTransaction(wrongTransaction);
  const { activity } = await fixture();
  const wrongActivity = { ...activity,
    intent: { signTransactionIntentV2: { signWith: account.address,
      unsignedTransaction: serializeTransaction(wrongTransaction) } },
    result: { signTransactionResult: { signedTransaction } } };
  const result = await verifyAmbiguousSigningActivity({ record, activity: wrongActivity,
    ...evidenceConfig });
  assert.equal(result.verified, false);
  assert.ok(result.failures.includes("turnkey-activity-intent-mismatch"));
});

test("fails closed when gas, fee, or transaction-type safeguards drift", async () => {
  const { activity } = await fixture();
  for (const config of [
    { maxGas: "100000", maxFeePerGasWei: "2000000000" },
    { maxGas: "200000", maxFeePerGasWei: "999999999" },
    { maxGas: undefined, maxFeePerGasWei: "2000000000" },
  ]) {
    const result = await verifyAmbiguousSigningActivity({ record, activity,
      organizationId, walletAddress: account.address, signingUserId, ...config });
    assert.equal(result.verified, false);
    assert.ok(result.failures.includes("turnkey-activity-gas-fee-limit"));
  }
});
