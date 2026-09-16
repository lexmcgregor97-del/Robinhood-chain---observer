import test from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, parseTransaction } from "viem";
import { ROBINHOOD } from "./chain-config.js";
import { V2_ROUTER_ABI } from "./router-calldata.js";
import {
  buildTurnkeyBehavioralCases, runTurnkeyBehavioralMatrix, submitActivity,
} from "./run-turnkey-behavioral-matrix.js";

const router = "0x2222222222222222222222222222222222222222";
const wallet = "0x1111111111111111111111111111111111111111";
const token = "0x3333333333333333333333333333333333333333";
const config = { organizationId: "11111111-1111-7111-8111-111111111111",
  walletAddress: wallet, allowedRouters: [router], maxPerTransactionWei: "1000",
  maxDailyWei: "4000", maxGas: "400000", maxFeePerGasWei: "2000000000" };

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
    signWith: config.walletAddress,
    type: "TRANSACTION_TYPE_ETHEREUM",
    unsignedTransaction: "1234",
  }]);
  assert.equal("parameters" in requests[0], false);
});

test("retains the activity id surfaced by an sdk-server policy denial", async () => {
  const denial = Object.assign(new Error("policy denied"),
    { activityId: "activity-denial" });
  const client = { signTransaction: async () => { throw denial; } };
  assert.equal(await submitActivity(client, config,
    { unsignedTransaction: "0x1234" }, false), "activity-denial");
});
