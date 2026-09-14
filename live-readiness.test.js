import test from "node:test";
import assert from "node:assert/strict";
import { assessLiveReadiness } from "./live-readiness.js";

const passing = {
  paper: { closedTrades: 50, expectancyPerTrade: 0.01, maxRealizedDrawdownPct: 5 },
  shadow: { uniquePools: 46, eligible: true },
  sellProbeReady: true, walletConfigured: true, rpcEndpointCount: 2, operationalReady: true,
  turnkeyPolicyAttested: true, evidenceJournalReady: true,
};

test("promotes only a fully qualified micro-mainnet configuration", () => {
  assert.equal(assessLiveReadiness(passing).eligibleForMicroMainnet, true);
});

test("reports every unresolved live boundary", () => {
  const result = assessLiveReadiness({ paper: {}, shadow: {} });
  assert.equal(result.eligibleForMicroMainnet, false);
  assert.deepEqual(result.failures, [
    "paper-sample-too-small", "paper-expectancy-not-positive",
    "shadow-evidence-insufficient", "sell-probe-not-ready", "wallet-not-configured",
    "turnkey-policy-not-attested", "rpc-redundancy-required", "runtime-not-ready",
    "evidence-journal-not-ready",
  ]);
  assert.equal(result.progress.paperTradesRemaining, 50);
});
