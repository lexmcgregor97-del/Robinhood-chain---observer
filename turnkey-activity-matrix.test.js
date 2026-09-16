import test from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, serializeTransaction } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { APPROVE_ABI } from "./approval-calldata.js";
import { ROBINHOOD } from "./chain-config.js";
import { V2_ROUTER_ABI } from "./router-calldata.js";
import {
  REQUIRED_DENIAL_CASES, verifyTurnkeyActivityMatrix,
} from "./turnkey-activity-matrix.js";

const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const router = "0x2222222222222222222222222222222222222222";
const token = "0x3333333333333333333333333333333333333333";
const foreign = "0x5555555555555555555555555555555555555555";
const organizationId = "11111111-1111-7111-8111-111111111111";
const signingUserId = "44444444-4444-7444-8444-444444444444";
const config = { organizationId, walletAddress: account.address,
  allowedRouters: [router], maxPerTransactionWei: "1000", maxGas: "400000",
  maxFeePerGasWei: "2000000000" };

async function signed(data, to = router) {
  return account.signTransaction({ chainId: ROBINHOOD.chainId, type: "eip1559",
    to, data, value: 0n, nonce: 1, gas: 150000n,
    maxFeePerGas: 1000000000n, maxPriorityFeePerGas: 1000000n });
}

function unsigned({ data, to = router, chainId = ROBINHOOD.chainId, value = 0n,
  nonce = 1, gas = 150000n, maxFeePerGas = 1000000000n,
  maxPriorityFeePerGas = 1000000n } = {}) {
  return serializeTransaction({ chainId, type: "eip1559", to, data, value,
    nonce, gas, maxFeePerGas, maxPriorityFeePerGas });
}

const swapData = ({ amountIn = 100n, amountOutMin = 90n,
  path = [ROBINHOOD.weth, token], recipient = account.address } = {}) =>
  encodeFunctionData({ abi: V2_ROUTER_ABI,
    functionName: "swapExactTokensForTokens",
    args: [amountIn, amountOutMin, path, recipient, 2_000_000_000n] });

function deniedTransactions() {
  const allowedBuy = swapData();
  return new Map([
    ["wrong-chain", unsigned({ data: allowedBuy, chainId: 1 })],
    ["non-zero-value", unsigned({ data: allowedBuy, value: 1n })],
    ["foreign-router", unsigned({ data: allowedBuy, to: foreign })],
    ["wrong-selector", unsigned({ data: `0xdeadbeef${allowedBuy.slice(10)}` })],
    ["excessive-input", unsigned({ data: swapData({ amountIn: 1001n }) })],
    ["zero-minimum-output", unsigned({ data: swapData({ amountOutMin: 0n }) })],
    ["three-token-path", unsigned({ data: swapData({
      path: [ROBINHOOD.weth, token, foreign] }) })],
    ["wrong-weth-orientation", unsigned({ data: swapData({ path: [token, foreign] }) })],
    ["foreign-recipient", unsigned({ data: swapData({ recipient: foreign }) })],
    ["excessive-gas-or-fee", unsigned({ data: allowedBuy, gas: 400001n })],
    ["excessive-fee", unsigned({ data: allowedBuy, maxFeePerGas: 2000000001n })],
    ["foreign-approval-spender", unsigned({ to: token,
      data: encodeFunctionData({ abi: APPROVE_ABI, functionName: "approve",
        args: [foreign, 100n] }) })],
    ["approve-max-uint", unsigned({ to: token,
      data: encodeFunctionData({ abi: APPROVE_ABI, functionName: "approve",
        args: [router, (1n << 256n) - 1n] }) })],
  ]);
}

function activityBase(id) {
  return { id, organizationId, type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
    intent: { signTransactionIntentV2: { signWith: account.address } },
    votes: [{ userId: signingUserId, selection: "VOTE_SELECTION_APPROVED" }] };
}

async function fixture() {
  const deadline = 2_000_000_000n;
  const buy = await signed(encodeFunctionData({ abi: V2_ROUTER_ABI,
    functionName: "swapExactTokensForTokens",
    args: [100n, 90n, [ROBINHOOD.weth, token], account.address, deadline] }));
  const sell = await signed(encodeFunctionData({ abi: V2_ROUTER_ABI,
    functionName: "swapExactTokensForTokens",
    args: [100n, 1n, [token, ROBINHOOD.weth], account.address, deadline] }));
  const approval = await signed(encodeFunctionData({ abi: APPROVE_ABI,
    functionName: "approve", args: [router, 100n] }), token);
  const approvalReset = await signed(encodeFunctionData({ abi: APPROVE_ABI,
    functionName: "approve", args: [router, 0n] }), token);
  const buyUnsigned = unsigned({ data: swapData() });
  const sellUnsigned = unsigned({ data: swapData({ amountOutMin: 1n,
    path: [token, ROBINHOOD.weth] }) });
  const approvalUnsigned = unsigned({ to: token,
    data: encodeFunctionData({ abi: APPROVE_ABI, functionName: "approve",
      args: [router, 100n] }) });
  const approvalResetUnsigned = unsigned({ to: token,
    data: encodeFunctionData({ abi: APPROVE_ABI, functionName: "approve",
      args: [router, 0n] }) });
  const allows = [
    { case: "buy", activityId: "allow-buy", signedTransaction: buy,
      unsignedTransaction: buyUnsigned },
    { case: "sell", activityId: "allow-sell", signedTransaction: sell,
      unsignedTransaction: sellUnsigned },
    { case: "approval", activityId: "allow-approval", signedTransaction: approval,
      unsignedTransaction: approvalUnsigned, token, amount: "100" },
    { case: "approval-reset", activityId: "allow-approval-reset",
      signedTransaction: approvalReset, unsignedTransaction: approvalResetUnsigned,
      token, amount: "0" },
  ];
  const denials = REQUIRED_DENIAL_CASES.map((kind, index) =>
    ({ case: kind, activityId: `deny-${index + 1}` }));
  const denied = deniedTransactions();
  const activities = new Map(allows.map((entry) => [entry.activityId, {
    ...activityBase(entry.activityId), status: "ACTIVITY_STATUS_COMPLETED",
    intent: { signTransactionIntentV2: { signWith: account.address,
      unsignedTransaction: entry.unsignedTransaction } },
    result: { signTransactionResult: { signedTransaction: entry.signedTransaction } },
  }]));
  for (const entry of denials) activities.set(entry.activityId, {
    ...activityBase(entry.activityId), status: "ACTIVITY_STATUS_REJECTED",
    intent: { signTransactionIntentV2: { signWith: account.address,
      unsignedTransaction: denied.get(entry.case) } },
    failure: { code: 7, message: "request rejected: policy denied" },
  });
  return { matrix: { runAt: Date.now(), allows: allows.map(({ signedTransaction, ...entry }) => entry),
    denials }, activities };
}

test("verifies real completed signing outcomes and policy-denied activities", async () => {
  const { matrix, activities } = await fixture();
  const result = await verifyTurnkeyActivityMatrix({ matrix, config, signingUserId,
    getActivity: async ({ activityId }) => ({ activity: activities.get(activityId) }) });
  assert.equal(result.verified, true);
  assert.deepEqual(result.normalized.allows,
    ["allow-buy", "allow-sell", "allow-approval", "allow-approval-reset"]);
  assert.equal(result.normalized.denials.length, 13);
});

test("accepts Turnkey transaction payloads without a 0x prefix", async () => {
  const { matrix, activities } = await fixture();
  for (const entry of matrix.allows) {
    const activity = activities.get(entry.activityId);
    activity.result.signTransactionResult.signedTransaction =
      activity.result.signTransactionResult.signedTransaction.slice(2);
  }
  for (const entry of matrix.denials) {
    const intent = activities.get(entry.activityId).intent.signTransactionIntentV2;
    intent.unsignedTransaction = intent.unsignedTransaction.slice(2);
  }
  const result = await verifyTurnkeyActivityMatrix({ matrix, config, signingUserId,
    getActivity: async ({ activityId }) => activities.get(activityId) });
  assert.equal(result.verified, true);
});

test("accepts the null failure shape exported for a rejected Turnkey policy activity", async () => {
  const { matrix, activities } = await fixture();
  for (const entry of matrix.denials) activities.get(entry.activityId).failure = null;
  const result = await verifyTurnkeyActivityMatrix({ matrix, config, signingUserId,
    getActivity: async ({ activityId }) => ({ activity: activities.get(activityId) }) });
  assert.equal(result.verified, true);
});

test("rejects malformed serialized hex before parsing", async () => {
  const { matrix, activities } = await fixture();
  activities.get("allow-buy").result.signTransactionResult.signedTransaction = "not-hex";
  activities.get("deny-1").intent.signTransactionIntentV2.unsignedTransaction = "abc";
  activities.get("deny-2").intent.signTransactionIntentV2.unsignedTransaction = "";
  const result = await verifyTurnkeyActivityMatrix({ matrix, config, signingUserId,
    getActivity: async ({ activityId }) => activities.get(activityId) });
  assert.equal(result.verified, false);
  assert.ok(result.failures.includes("matrix-signed-transaction-invalid"));
  assert.ok(result.failures.includes("matrix-denied-transaction-invalid"));
});

test("rejects fabricated IDs, missing cases, and non-policy failures", async () => {
  const malformed = await verifyTurnkeyActivityMatrix({ matrix: {
    runAt: Date.now(), allows: ["a", "b", "c", "d"], denials: Array(12).fill("e") },
  config, signingUserId, getActivity: async () => ({}) });
  assert.equal(malformed.verified, false);
  assert.ok(malformed.failures.includes("behavioral-matrix-allow-cases-incomplete"));

  const { matrix, activities } = await fixture();
  activities.get("deny-1").failure = { code: 13, message: "internal error" };
  const result = await verifyTurnkeyActivityMatrix({ matrix, config, signingUserId,
    getActivity: async ({ activityId }) => activities.get(activityId) });
  assert.equal(result.verified, false);
  assert.ok(result.failures.includes("matrix-policy-denial-unverified"));
});

test("rejects a completed activity from the wrong organization or signer", async () => {
  const { matrix, activities } = await fixture();
  const buy = activities.get("allow-buy");
  buy.organizationId = "wrong-organization";
  buy.votes = [{ userId: "wrong-user", selection: "VOTE_SELECTION_APPROVED" }];
  const result = await verifyTurnkeyActivityMatrix({ matrix, config, signingUserId,
    getActivity: async ({ activityId }) => activities.get(activityId) });
  assert.equal(result.verified, false);
  assert.ok(result.failures.includes("matrix-organization-mismatch"));
  assert.ok(result.failures.includes("matrix-signing-user-vote-missing"));
});

test("rejects a signed allow result that differs from the submitted intent", async () => {
  const { matrix, activities } = await fixture();
  const approval = matrix.allows.find((entry) => entry.case === "approval");
  activities.get(approval.activityId).intent.signTransactionIntentV2.unsignedTransaction =
    unsigned({ to: token, data: encodeFunctionData({ abi: APPROVE_ABI,
      functionName: "approve", args: [router, 100n] }), nonce: 2 });
  const result = await verifyTurnkeyActivityMatrix({ matrix, config, signingUserId,
    getActivity: async ({ activityId }) => activities.get(activityId) });
  assert.equal(result.verified, false);
  assert.ok(result.failures.includes("matrix-signed-transaction-mismatch"));
});

test("rejects relabelled denials unless the unsigned transaction has exactly the named defect", async () => {
  const { matrix, activities } = await fixture();
  activities.get("deny-2").intent.signTransactionIntentV2.unsignedTransaction =
    activities.get("deny-1").intent.signTransactionIntentV2.unsignedTransaction;
  const result = await verifyTurnkeyActivityMatrix({ matrix, config, signingUserId,
    getActivity: async ({ activityId }) => activities.get(activityId) });
  assert.equal(result.verified, false);
  assert.ok(result.failures.includes("matrix-denial-case-mismatch"));
});

test("rejects a denial carrying the named defect plus a second defect", async () => {
  const { matrix, activities } = await fixture();
  activities.get("deny-1").intent.signTransactionIntentV2.unsignedTransaction = unsigned({
    data: swapData({ amountOutMin: 0n }), chainId: 1,
  });
  const result = await verifyTurnkeyActivityMatrix({ matrix, config, signingUserId,
    getActivity: async ({ activityId }) => activities.get(activityId) });
  assert.equal(result.verified, false);
  assert.ok(result.failures.includes("matrix-denial-case-mismatch"));
});

test("does not treat an otherwise allowed sell orientation as a denied buy orientation", async () => {
  const { matrix, activities } = await fixture();
  activities.get("deny-8").intent.signTransactionIntentV2.unsignedTransaction = unsigned({
    data: swapData({ path: [token, ROBINHOOD.weth] }),
  });
  const result = await verifyTurnkeyActivityMatrix({ matrix, config, signingUserId,
    getActivity: async ({ activityId }) => activities.get(activityId) });
  assert.equal(result.verified, false);
  assert.ok(result.failures.includes("matrix-denial-case-mismatch"));
});
