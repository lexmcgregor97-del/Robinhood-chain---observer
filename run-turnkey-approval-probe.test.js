import test from "node:test";
import assert from "node:assert/strict";
import { parseTransaction } from "viem";
import {
  approvalProbeErrorMessage, runTurnkeyApprovalProbe,
} from "./run-turnkey-approval-probe.js";

const env = {
  TURNKEY_APPROVAL_PROBE_CONFIRMATION: "RUN_ATLAS_TURNKEY_APPROVAL_PROBE_NO_BROADCAST",
  ATLAS_EXECUTION_MODE: "MICRO_MAINNET",
  MICRO_MAINNET_ENABLED: "true",
  TURNKEY_SIGNING_ORGANIZATION_ID: "11111111-1111-7111-8111-111111111111",
  TURNKEY_ORGANIZATION_ID: "11111111-1111-7111-8111-111111111111",
  TURNKEY_SIGNING_WALLET_ADDRESS: "0x11111111111111111111111111111111111111AA",
  TURNKEY_WALLET_ADDRESS: "0x11111111111111111111111111111111111111AA",
  TURNKEY_SIGNING_BUY_POLICY_ID: "22222222-2222-7222-8222-222222222222",
  TURNKEY_SIGNING_SELL_POLICY_ID: "33333333-3333-7333-8333-333333333333",
  TURNKEY_SIGNING_APPROVAL_POLICY_ID: "44444444-4444-7444-8444-444444444444",
  TURNKEY_SIGNING_API_PUBLIC_KEY: `02${"ab".repeat(32)}`,
  TURNKEY_API_PUBLIC_KEY: `03${"cd".repeat(32)}`,
  TURNKEY_SIGNING_VERIFY_API_PRIVATE_KEY: "private",
  MICRO_MAINNET_V2_ROUTERS: "0x2222222222222222222222222222222222222222",
  MICRO_MAINNET_MAX_WETH_PER_TX_WEI: "1000",
  MICRO_MAINNET_MAX_WETH_DAILY_WEI: "4000",
  MICRO_MAINNET_MAX_GAS: "400000",
  MICRO_MAINNET_MAX_FEE_PER_GAS_WEI: "2000000000",
  MICRO_MAINNET_CONFIRMATION:
    "ENABLE_ATLAS_MICRO_MAINNET:4663:0x11111111111111111111111111111111111111aa",
  TURNKEY_MATRIX_TOKEN_ADDRESS: "0x3333333333333333333333333333333333333333",
  LIVE_WORKER_SUBMISSION_CONNECTED: "false",
  LIVE_WORKER_AUTOMATIC_SUBMISSION_ENABLED: "false",
};

test("refuses before client construction without the exact confirmation", async () => {
  let constructed = false;
  await assert.rejects(runTurnkeyApprovalProbe({}, {
    makeClient: () => { constructed = true; },
  }), /turnkey-approval-probe-confirmation-required/);
  assert.equal(constructed, false);
});

test("refuses live-worker activation flags before private configuration", async () => {
  for (const flag of [
    "LIVE_WORKER_SUBMISSION_CONNECTED",
    "LIVE_WORKER_AUTOMATIC_SUBMISSION_ENABLED",
  ]) {
    await assert.rejects(runTurnkeyApprovalProbe({ ...env, [flag]: "true" }),
      /turnkey-approval-probe-live-flags-forbidden/);
  }
});

test("verifies the exact policy set before one unreachable approval and no broadcast", async () => {
  const calls = [];
  const client = {
    signTransaction: async (request) => {
      calls.push(request);
      return { activity: { id: "approval-activity" } };
    },
    getActivity: async (request) => ({ activity: { id: request.activityId } }),
  };
  let verifiedEntry;
  const result = await runTurnkeyApprovalProbe(env, {
    makeClient: () => client,
    verifyPolicy: async () => ({ verified: true, userId: "signing-user", failures: [] }),
    verifyActivity: async ({ entry }) => {
      verifiedEntry = entry;
      return { verified: true, failures: [] };
    },
  });
  assert.deepEqual(result, { verified: true, case: "approval",
    activityId: "approval-activity", activityCount: 1, broadcastCount: 0 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].signWith, env.TURNKEY_SIGNING_WALLET_ADDRESS);
  const transaction = parseTransaction(`0x${calls[0].unsignedTransaction}`);
  assert.equal(transaction.nonce, Number.MAX_SAFE_INTEGER);
  assert.equal(transaction.to.toLowerCase(), env.TURNKEY_MATRIX_TOKEN_ADDRESS.toLowerCase());
  assert.equal(verifiedEntry.case, "approval");
});

test("does not request a signature when the configured policy set is not exact", async () => {
  let signed = false;
  await assert.rejects(runTurnkeyApprovalProbe(env, {
    makeClient: () => ({ signTransaction: async () => { signed = true; } }),
    verifyPolicy: async () => ({ verified: false, userId: "signing-user",
      failures: ["turnkey-signing-policy-set-not-exact"] }),
  }), /turnkey-approval-probe-policy-verification-failed/);
  assert.equal(signed, false);
});

test("redacts unrecognized SDK errors while preserving coded probe failures", () => {
  assert.equal(approvalProbeErrorMessage(new Error(
    "request failed for organization secret-context")),
  "turnkey-approval-probe-failed");
  assert.equal(approvalProbeErrorMessage(new Error(
    "turnkey-approval-probe-config-invalid")),
  "turnkey-approval-probe-config-invalid");
});
