import test from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData } from "viem";
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
  const allows = [
    { case: "buy", activityId: "allow-buy", signedTransaction: buy },
    { case: "sell", activityId: "allow-sell", signedTransaction: sell },
    { case: "approval", activityId: "allow-approval", signedTransaction: approval,
      token, amount: "100" },
  ];
  const denials = REQUIRED_DENIAL_CASES.map((kind, index) =>
    ({ case: kind, activityId: `deny-${index + 1}` }));
  const activities = new Map(allows.map((entry) => [entry.activityId, {
    ...activityBase(entry.activityId), status: "ACTIVITY_STATUS_COMPLETED",
    result: { signTransactionResult: { signedTransaction: entry.signedTransaction } },
  }]));
  for (const entry of denials) activities.set(entry.activityId, {
    ...activityBase(entry.activityId), status: "ACTIVITY_STATUS_REJECTED",
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
    ["allow-buy", "allow-sell", "allow-approval"]);
  assert.equal(result.normalized.denials.length, 12);
});

test("rejects fabricated IDs, missing cases, and non-policy failures", async () => {
  const malformed = await verifyTurnkeyActivityMatrix({ matrix: {
    runAt: Date.now(), allows: ["a", "b", "c"], denials: Array(12).fill("d") },
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
