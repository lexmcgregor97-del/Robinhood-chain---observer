import test from "node:test";
import assert from "node:assert/strict";
import { createObserverReadinessAdapter, createSigningPolicyAdapter }
  from "./live-worker-adapters.js";

test("accepts only a fresh healthy observer cohort with no pending execution", async () => {
  const now = 1_000_000;
  const adapter = createObserverReadinessAdapter({ url: "https://observer.example",
    expectedHostname: "observer.example",
    bearerToken: "a".repeat(32),
    fetchImpl: async (_url, request) => {
      assert.equal(request.headers.authorization, `Bearer ${"a".repeat(32)}`);
      return { ok: true, json: async () => ({ mode: "PAPER_ONLY",
      newEntriesPaused: false, automationBlockedReason: null,
      automation: { lastCycleAt: now - 1 }, evidence: { healthy: true },
      execution: { durability: { pendingExecutions: 0 },
        signingVerification: { attestationVerified: true } },
      liveReadiness: { eligibleForMicroMainnet: true } }) }; } });
  assert.equal((await adapter({ now })).eligibleForMicroMainnet, true);
});

test("fails closed on stale or unreachable observer readiness", async () => {
  const stale = createObserverReadinessAdapter({ url: "https://observer.example",
    expectedHostname: "observer.example",
    bearerToken: "a".repeat(32),
    maxAgeMs: 10, fetchImpl: async () => ({ ok: true, json: async () => ({
      mode: "PAPER_ONLY", automation: { lastCycleAt: 1 }, evidence: { healthy: true },
      execution: { durability: { pendingExecutions: 0 } },
      liveReadiness: { eligibleForMicroMainnet: true } }) }) });
  assert.equal((await stale({ now: 100 })).eligibleForMicroMainnet, false);
  const down = createObserverReadinessAdapter({ url: "https://observer.example",
    expectedHostname: "observer.example",
    bearerToken: "a".repeat(32),
    fetchImpl: async () => { throw new Error("secret provider text"); } });
  assert.deepEqual((await down()).failures, ["observer-live-readiness-unavailable"]);
});

test("refuses readiness requests to a host other than the pinned observer", () => {
  assert.throws(() => createObserverReadinessAdapter({ url: "https://observer.example",
    expectedHostname: "different.example", bearerToken: "a".repeat(32) }),
  /hostname-mismatch/);
});

test("signing adapter converts probe failures to a closed credential boundary", async () => {
  const client = { getWhoami: async () => { throw new Error("private"); },
    getOrganizationConfigs: async () => ({}), getPolicies: async () => ({}),
    getUser: async () => ({}) };
  const result = await createSigningPolicyAdapter({ config: {}, client })();
  assert.equal(result.credentialVerified, false);
  assert.equal(result.policyVerified, false);
  assert.deepEqual(result.failures, ["live-signing-policy-verification-failed"]);
});
