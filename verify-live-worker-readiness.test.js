import test from "node:test";
import assert from "node:assert/strict";
import { liveWorkerReadinessExitCode, verifyDormantObserverReadiness }
  from "./verify-live-worker-readiness.js";

const wallet = "0x1111111111111111111111111111111111111111";
const base = {
  ATLAS_EXECUTION_MODE: "MICRO_MAINNET",
  MICRO_MAINNET_ENABLED: "true",
  MICRO_MAINNET_CONFIRMATION: `ENABLE_ATLAS_MICRO_MAINNET:4663:${wallet}`,
  MICRO_MAINNET_MAX_FEE_PER_GAS_WEI: "2000000000",
  MICRO_MAINNET_MAX_GAS: "400000",
  MICRO_MAINNET_MAX_WETH_DAILY_WEI: "3000",
  MICRO_MAINNET_MAX_WETH_PER_TX_WEI: "1000",
  MICRO_MAINNET_V2_ROUTERS: "0x2222222222222222222222222222222222222222",
  TURNKEY_SIGNING_ORGANIZATION_ID: "11111111-1111-7111-8111-111111111111",
  TURNKEY_ORGANIZATION_ID: "11111111-1111-7111-8111-111111111111",
  TURNKEY_SIGNING_WALLET_ADDRESS: wallet,
  TURNKEY_WALLET_ADDRESS: wallet,
  TURNKEY_SIGNING_API_PUBLIC_KEY: `02${"ab".repeat(32)}`,
  TURNKEY_API_PUBLIC_KEY: `03${"cd".repeat(32)}`,
  TURNKEY_SIGNING_BUY_POLICY_ID: "22222222-2222-7222-8222-222222222222",
  TURNKEY_SIGNING_SELL_POLICY_ID: "33333333-3333-7333-8333-333333333333",
  TURNKEY_SIGNING_APPROVAL_POLICY_ID: "44444444-4444-7444-8444-444444444444",
  ATLAS_OBSERVER_URL: "https://observer.example",
  LIVE_WORKER_OBSERVER_HOSTNAME: "observer.example",
  LIVE_WORKER_OBSERVER_BEARER_TOKEN: "a".repeat(64),
  LIVE_WORKER_STATE_FILE: "/data/state.json",
  LIVE_WORKER_EVIDENCE_FILE: "/data/evidence.jsonl",
  LIVE_WORKER_V2_ROUTER_ADDRESS: "0x2222222222222222222222222222222222222222",
  LIVE_WORKER_BUY_AMOUNT_WEI: "1000",
  LIVE_WORKER_MAX_ALLOWANCE_WEI: "1000",
  LIVE_WORKER_MIN_NATIVE_BALANCE_WEI: "1",
  LIVE_WORKER_SUBMISSION_CONNECTED: "false",
  LIVE_WORKER_AUTOMATIC_SUBMISSION_ENABLED: "false",
};

test("proves authenticated observer reachability while reporting readiness blockers", async () => {
  const now = 1_000_000;
  const result = await verifyDormantObserverReadiness(base, { now,
    fetchImpl: async (_url, request) => {
      assert.equal(request.headers.authorization, `Bearer ${"a".repeat(64)}`);
      return { ok: true, json: async () => ({ mode: "PAPER_ONLY",
        newEntriesPaused: false, automationBlockedReason: null,
        automation: { lastCycleAt: now - 1 }, evidence: { healthy: true },
        execution: { durability: { pendingExecutions: 0 },
          signingVerification: { attestationVerified: false } },
        liveReadiness: { eligibleForMicroMainnet: false } }) };
    } });
  assert.equal(result.verified, true);
  assert.equal(result.probe, "observer-endpoint-verification-only");
  assert.equal(result.endpointAuthenticated, true);
  assert.equal(result.responseValid, true);
  assert.equal(result.eligibleForMicroMainnet, false);
  assert.deepEqual(result.failures, ["observer-live-readiness-not-current"]);
  assert.equal(JSON.stringify(result).includes(base.LIVE_WORKER_OBSERVER_BEARER_TOKEN), false);
});

test("rejects authenticated malformed observer output", async () => {
  const result = await verifyDormantObserverReadiness(base, {
    fetchImpl: async () => ({ ok: true, json: async () => ({ mode: "PAPER_ONLY" }) }),
  });
  assert.equal(result.verified, false);
  assert.equal(result.endpointAuthenticated, true);
  assert.equal(result.responseValid, false);
  assert.deepEqual(result.failures, ["observer-live-readiness-invalid"]);
});

test("fails when observer authentication or reachability fails", async () => {
  const result = await verifyDormantObserverReadiness(base, {
    fetchImpl: async () => ({ ok: false, json: async () => ({ secret: "never returned" }) }),
  });
  assert.equal(result.verified, false);
  assert.equal(result.endpointAuthenticated, false);
  assert.deepEqual(result.failures, ["observer-live-readiness-http-error"]);
});

test("refuses network access when either activation flag is enabled", async () => {
  for (const [key, failure] of [
    ["LIVE_WORKER_SUBMISSION_CONNECTED",
      "live-worker-readiness-submission-must-remain-disabled"],
    ["LIVE_WORKER_AUTOMATIC_SUBMISSION_ENABLED",
      "live-worker-readiness-automatic-must-remain-disabled"],
  ]) {
    let called = false;
    const result = await verifyDormantObserverReadiness({ ...base, [key]: "true" }, {
      fetchImpl: async () => { called = true; throw new Error("must not run"); },
    });
    assert.equal(called, false);
    assert.equal(result.verified, false);
    assert.equal(result.responseValid, false);
    assert.ok(result.failures.includes(failure));
  }
});

test("pins CLI exit semantics to endpoint verification rather than eligibility", () => {
  assert.equal(liveWorkerReadinessExitCode({ verified: true,
    eligibleForMicroMainnet: false }), 0);
  assert.equal(liveWorkerReadinessExitCode({ verified: false,
    eligibleForMicroMainnet: true }), 1);
});
