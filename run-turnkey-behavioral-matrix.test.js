import test from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, parseTransaction } from "viem";
import { ROBINHOOD } from "./chain-config.js";
import { V2_ROUTER_ABI } from "./router-calldata.js";
import {
  buildTurnkeyBehavioralCases, recoverExpectedDenialActivity,
  runTurnkeyBehavioralMatrix, submitActivity,
} from "./run-turnkey-behavioral-matrix.js";

const router = "0x2222222222222222222222222222222222222222";
const wallet = "0x1111111111111111111111111111111111111111";
const token = "0x3333333333333333333333333333333333333333";
const config = { organizationId: "11111111-1111-7111-8111-111111111111",
  walletAddress: wallet, walletSignWith: "0x11111111111111111111111111111111111111AA",
  allowedRouters: [router], maxPerTransactionWei: "1000",
  maxDailyWei: "4000", maxGas: "400000", maxFeePerGasWei: "2000000000" };
const matrixEnv = {
  TURNKEY_MATRIX_CONFIRMATION: "RUN_ATLAS_TURNKEY_MATRIX_NO_BROADCAST",
  ATLAS_EXECUTION_MODE: "MICRO_MAINNET",
  MICRO_MAINNET_ENABLED: "true",
  TURNKEY_SIGNING_ORGANIZATION_ID: config.organizationId,
  TURNKEY_ORGANIZATION_ID: config.organizationId,
  TURNKEY_SIGNING_WALLET_ADDRESS: config.walletSignWith,
  TURNKEY_WALLET_ADDRESS: config.walletSignWith,
  TURNKEY_SIGNING_BUY_POLICY_ID: "22222222-2222-7222-8222-222222222222",
  TURNKEY_SIGNING_SELL_POLICY_ID: "33333333-3333-7333-8333-333333333333",
  TURNKEY_SIGNING_APPROVAL_POLICY_ID: "44444444-4444-7444-8444-444444444444",
  TURNKEY_SIGNING_API_PUBLIC_KEY: `02${"ab".repeat(32)}`,
  TURNKEY_API_PUBLIC_KEY: `03${"cd".repeat(32)}`,
  TURNKEY_SIGNING_VERIFY_API_PRIVATE_KEY: "private",
  TURNKEY_SIGNING_BEHAVIORAL_MATRIX_FILE: "/tmp/matrix.json",
  TURNKEY_MATRIX_TOKEN_ADDRESS: token,
  MICRO_MAINNET_V2_ROUTERS: router,
  MICRO_MAINNET_MAX_WETH_PER_TX_WEI: config.maxPerTransactionWei,
  MICRO_MAINNET_MAX_WETH_DAILY_WEI: config.maxDailyWei,
  MICRO_MAINNET_MAX_GAS: config.maxGas,
  MICRO_MAINNET_MAX_FEE_PER_GAS_WEI: config.maxFeePerGasWei,
  MICRO_MAINNET_CONFIRMATION:
    `ENABLE_ATLAS_MICRO_MAINNET:4663:${config.walletSignWith.toLowerCase()}`,
  LIVE_WORKER_SUBMISSION_CONNECTED: "false",
  LIVE_WORKER_AUTOMATIC_SUBMISSION_ENABLED: "false",
};

test("builds four allowed activities and every exact named denial without RPC", () => {
  const cases = buildTurnkeyBehavioralCases(config, token);
  assert.deepEqual(cases.allows.map((entry) => entry.case),
    ["buy", "sell", "approval", "approval-reset"]);
  assert.equal(cases.denials.length, 13);
  assert.equal(new Set(cases.denials.map((entry) => entry.case)).size, 13);
  const buy = parseTransaction(cases.allows[0].unsignedTransaction);
  const call = decodeFunctionData({ abi: V2_ROUTER_ABI, data: buy.data });
  assert.equal(buy.chainId, ROBINHOOD.chainId);
  assert.equal(buy.nonce, Number.MAX_SAFE_INTEGER);
  assert.equal(call.functionName, "swapExactTokensForTokens");
  assert.equal(call.args[4], 1n);
  assert.equal(call.args[2][0].toLowerCase(), ROBINHOOD.weth.toLowerCase());
  const sell = parseTransaction(cases.allows[1].unsignedTransaction);
  const sellCall = decodeFunctionData({ abi: V2_ROUTER_ABI, data: sell.data });
  assert.equal(sellCall.args[2][1].toLowerCase(), ROBINHOOD.weth.toLowerCase());
});

test("refuses before client construction without the exact isolated confirmation", async () => {
  let constructed = false;
  await assert.rejects(runTurnkeyBehavioralMatrix({}, {
    makeClient: () => { constructed = true; },
  }), /turnkey-matrix-confirmation-required/);
  assert.equal(constructed, false);
});

test("refuses live-worker activation flags before reading private configuration", async () => {
  for (const flag of [
    "LIVE_WORKER_SUBMISSION_CONNECTED",
    "LIVE_WORKER_AUTOMATIC_SUBMISSION_ENABLED",
  ]) {
    await assert.rejects(runTurnkeyBehavioralMatrix({
      TURNKEY_MATRIX_CONFIRMATION: "RUN_ATLAS_TURNKEY_MATRIX_NO_BROADCAST",
      [flag]: "true",
    }), /turnkey-matrix-live-flags-forbidden/);
  }
});

test("verifies the exact policy set before requesting any matrix signature", async () => {
  let signed = false;
  await assert.rejects(runTurnkeyBehavioralMatrix(matrixEnv, {
    makeClient: () => ({ signTransaction: async () => { signed = true; } }),
    verifyPolicy: async () => ({ verified: false, userId: "signing-user",
      failures: ["turnkey-signing-policy-set-not-exact"] }),
  }), /turnkey-matrix-policy-verification-failed:turnkey-signing-policy-set-not-exact/);
  assert.equal(signed, false);
});

test("submits the sdk-server transaction shape without the HTTP activity envelope", async () => {
  const requests = [];
  const client = { signTransaction: async (request) => {
    requests.push(request);
    return { activity: { id: "activity-allow" } };
  } };
  assert.equal(await submitActivity(client, config,
    { unsignedTransaction: "0x1234" }, true), "activity-allow");
  assert.deepEqual(requests, [{
    organizationId: config.organizationId,
    signWith: config.walletSignWith,
    type: "TRANSACTION_TYPE_ETHEREUM",
    unsignedTransaction: "1234",
  }]);
  assert.equal("parameters" in requests[0], false);
});

test("accepts the flattened sdk-server activity-id response shape", async () => {
  const client = { signTransaction: async () => ({
    activityId: "activity-flattened", signedTransaction: "0x1234",
  }) };
  assert.equal(await submitActivity(client, config,
    { unsignedTransaction: "0x1234" }, true), "activity-flattened");
});

test("retains the activity id surfaced by an sdk-server policy denial", async () => {
  const denial = Object.assign(new Error("policy denied"),
    { activityId: "activity-denial" });
  const client = { signTransaction: async () => { throw denial; } };
  assert.equal(await submitActivity(client, config,
    { unsignedTransaction: "0x1234" }, false), "activity-denial");
});

test("reports an unexpectedly completed denial without attempting rejection recovery", async () => {
  let listed = false;
  const client = {
    signTransaction: async () => ({ activity: { id: "activity-unexpected-allow" } }),
    getActivities: async () => { listed = true; return { activities: [] }; },
  };
  await assert.rejects(submitActivity(client, config,
    { case: "approve-max-uint", unsignedTransaction: "0x1234" }, false),
  /turnkey-matrix-denial-unexpectedly-completed:approve-max-uint:activity-unexpected-allow/);
  assert.equal(listed, false);
});

test("recovers an expected denial omitted from the sdk error", async () => {
  const entry = { unsignedTransaction: "0x1234" };
  const client = {
    signTransaction: async () => { throw new Error("policy denied"); },
    getActivities: async (request) => {
      assert.deepEqual(request.filterByStatus,
        ["ACTIVITY_STATUS_FAILED", "ACTIVITY_STATUS_REJECTED"]);
      return { activities: [{ id: "activity-rejected",
        organizationId: config.organizationId,
        type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
        status: "ACTIVITY_STATUS_REJECTED",
        createdAt: { seconds: String(Math.floor(Date.now() / 1000)), nanos: "0" },
        intent: { signTransactionIntentV2: {
          signWith: config.walletSignWith.toLowerCase(), unsignedTransaction: "1234",
        } },
      }] };
    },
  };
  assert.equal(await submitActivity(client, config, entry, false), "activity-rejected");
});

test("denial recovery rejects ambiguous matching activities", async () => {
  const activity = { id: "one", organizationId: config.organizationId,
    type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2", status: "ACTIVITY_STATUS_REJECTED",
    createdAt: { seconds: String(Math.floor(Date.now() / 1000)), nanos: "0" },
    intent: { signTransactionIntentV2: {
      signWith: config.walletSignWith, unsignedTransaction: "1234",
    } } };
  await assert.rejects(recoverExpectedDenialActivity({
    getActivities: async () => ({ activities: [activity, { ...activity, id: "two" }] }),
  }, config, { unsignedTransaction: "0x1234" }, Date.now(), { attempts: 1 }),
  /denial-activity-ambiguous/);
});
