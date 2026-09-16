import { probeTurnkeySigningPolicy } from "./turnkey-signing-probe.js";
import { probeV2Sell } from "./v2-sell-probe.js";

const LIVE_READINESS_FAILURE_KEYS = Object.freeze({
  "paper-sample-too-small": "paperSampleTooSmall",
  "paper-pool-diversity-insufficient": "paperPoolDiversityInsufficient",
  "paper-expectancy-not-positive": "paperExpectancyNotPositive",
  "paper-drawdown-too-high": "paperDrawdownTooHigh",
  "paper-measurement-failures-present": "paperMeasurementFailuresPresent",
  "shadow-evidence-insufficient": "shadowEvidenceInsufficient",
  "sell-probe-not-ready": "sellProbeNotReady",
  "wallet-not-configured": "walletNotConfigured",
  "turnkey-policy-not-attested": "turnkeyPolicyNotAttested",
  "turnkey-policy-not-verified": "turnkeyPolicyNotVerified",
  "rpc-redundancy-required": "rpcRedundancyRequired",
  "runtime-not-ready": "runtimeNotReady",
  "evidence-journal-not-ready": "evidenceJournalNotReady",
  "paper-recovery-gaps-present": "paperRecoveryGapsPresent",
});

const PAPER_EXIT_REASONS = Object.freeze([
  "stop-loss", "take-profit", "trailing-stop", "max-hold",
  "liquidity-collapse", "liquidity-zero", "price-unavailable-timeout",
]);

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sanitizedPaperCohort(body) {
  const analytics = body?.books?.WETH?.analytics;
  const fields = ["closedTrades", "wins", "losses", "winRatePct", "realizedPnl",
    "expectancyPerTrade", "averageWin", "averageLoss", "averageHoldMs",
    "maxRealizedDrawdownPct", "maxMarkedDrawdownPct", "measurementFailures",
    "uniquePools", "feesPaid", "gasPaid"];
  if (!analytics || fields.some((field) => finiteNumber(analytics[field]) === null)) return null;
  const byExitReason = {};
  for (const reason of PAPER_EXIT_REASONS) {
    const group = analytics.byExitReason?.[reason];
    byExitReason[reason] = Object.freeze({
      trades: finiteNumber(group?.trades) ?? 0,
      wins: finiteNumber(group?.wins) ?? 0,
      losses: finiteNumber(group?.losses) ?? 0,
      pnl: finiteNumber(group?.pnl) ?? 0,
      averageReturnPct: finiteNumber(group?.averageReturnPct) ?? 0,
    });
  }
  const knownTrades = Object.values(byExitReason)
    .reduce((sum, group) => sum + group.trades, 0);
  return Object.freeze({
    ...Object.fromEntries(fields.map((field) => [field, Number(analytics[field])])),
    byExitReason: Object.freeze(byExitReason),
    unknownExitReasonTrades: Math.max(0, Number(analytics.closedTrades) - knownTrades),
  });
}

function sanitizedLiveReadinessBlockers(failures) {
  const failureSet = new Set(failures);
  const blockers = Object.fromEntries(Object.entries(LIVE_READINESS_FAILURE_KEYS)
    .map(([failure, key]) => [key, failureSet.has(failure)]));
  blockers.unknownReasonPresent = failures.some(
    (failure) => !Object.hasOwn(LIVE_READINESS_FAILURE_KEYS, failure));
  return Object.freeze(blockers);
}

export function createObserverReadinessAdapter({ url, expectedHostname, bearerToken, fetchImpl = fetch,
  maxAgeMs = 30_000, timeoutMs = 5_000 } = {}) {
  const endpoint = new URL("/api/live-worker/readiness", url);
  if (endpoint.protocol !== "https:" && endpoint.hostname !== "localhost") {
    throw new Error("observer-readiness-https-required");
  }
  if (!expectedHostname || endpoint.hostname.toLowerCase() !== String(expectedHostname).toLowerCase()) {
    throw new Error("observer-readiness-hostname-mismatch");
  }
  if (String(bearerToken || "").length < 32) throw new Error("observer-readiness-auth-required");
  return async ({ now = Date.now() } = {}) => {
    try {
      const response = await fetchImpl(endpoint, { method: "GET",
        headers: { accept: "application/json", authorization: `Bearer ${bearerToken}` },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) return Object.freeze({
        endpointAuthenticated: false, responseValid: false,
        eligibleForMicroMainnet: false, checks: null, liveReadinessBlockers: null,
        paperCohort: null,
        failures: Object.freeze([response.status === 401 || response.status === 403
          ? "observer-live-readiness-unauthorized"
          : "observer-live-readiness-http-error"]),
      });
      if (response.redirected === true) throw new Error();
      if (response.url) {
        const finalUrl = new URL(response.url);
        if (finalUrl.origin.toLowerCase() !== endpoint.origin.toLowerCase()) throw new Error();
      }
      const body = await response.json();
      const responseValid = body?.mode === "PAPER_ONLY"
        && typeof body?.newEntriesPaused === "boolean"
        && (body?.automationBlockedReason == null
          || typeof body.automationBlockedReason === "string")
        && body?.automation !== null && typeof body?.automation === "object"
        && typeof body?.evidence?.healthy === "boolean"
        && Number.isSafeInteger(body?.execution?.durability?.pendingExecutions)
        && typeof body?.liveReadiness?.eligibleForMicroMainnet === "boolean"
        && Array.isArray(body?.liveReadiness?.failures)
        && body.liveReadiness.failures.every((failure) => typeof failure === "string");
      if (!responseValid) return Object.freeze({
        endpointAuthenticated: true, responseValid: false,
        eligibleForMicroMainnet: false, checks: null, liveReadinessBlockers: null,
        paperCohort: null,
        failures: Object.freeze(["observer-live-readiness-invalid"]),
      });
      const lastCycleAt = Number(body?.automation?.lastCycleAt);
      const fresh = Number.isSafeInteger(lastCycleAt) && lastCycleAt <= now
        && now - lastCycleAt <= maxAgeMs;
      const checks = Object.freeze({
        paperOnly: body.mode === "PAPER_ONLY",
        entriesUnpaused: body.newEntriesPaused === false,
        automationUnblocked: body.automationBlockedReason == null,
        evidenceHealthy: body.evidence.healthy === true,
        noPendingExecutions: body.execution.durability.pendingExecutions === 0,
        // The private worker verifies its own signing credential and exact policy
        // before constructing an account; observer signing metadata is not authority.
        liveReadinessEligible: body.liveReadiness.eligibleForMicroMainnet === true,
        cycleFresh: fresh,
      });
      const liveReadinessBlockers = sanitizedLiveReadinessBlockers(
        body.liveReadiness.failures);
      const paperCohort = sanitizedPaperCohort(body);
      const eligible = Object.values(checks).every((passed) => passed === true);
      return Object.freeze({ endpointAuthenticated: true, responseValid: true,
        eligibleForMicroMainnet: eligible, checks, liveReadinessBlockers, paperCohort,
        failures: eligible ? Object.freeze([])
          : Object.freeze(["observer-live-readiness-not-current"]) });
    } catch {
      return Object.freeze({ endpointAuthenticated: false, responseValid: false,
        eligibleForMicroMainnet: false, checks: null, liveReadinessBlockers: null,
        paperCohort: null,
        failures: Object.freeze(["observer-live-readiness-unavailable"]) });
    }
  };
}

export function createSigningPolicyAdapter({ config, client } = {}) {
  if (!client) throw new Error("live-signing-policy-client-required");
  return async () => {
    try {
      const result = await probeTurnkeySigningPolicy({ config,
        getWhoami: (request) => client.getWhoami(request),
        getOrganizationConfigs: (request) => client.getOrganizationConfigs(request),
        getPolicies: (request) => client.getPolicies(request),
        getUser: (request) => client.getUser(request) });
      return Object.freeze({ credentialVerified: result.apiKeyOwned === true,
        policyVerified: result.verified === true,
        failures: Object.freeze([...(result.failures || [])]) });
    } catch {
      return Object.freeze({ credentialVerified: false, policyVerified: false,
        failures: Object.freeze(["live-signing-policy-verification-failed"]) });
    }
  };
}

export function createLiveSellProbeAdapter({ rpc, config } = {}) {
  return async ({ candidate, chain, strategy, now = Date.now() } = {}) => {
    if (!strategy?.lastSwap || !strategy?.marketSafety) return Object.freeze({
      passed: false, checkedAt: new Date(now).toISOString(),
      failures: Object.freeze(["live-sell-probe-input-missing"]) });
    return probeV2Sell({ pool: { ...candidate, token0: chain.token0, token1: chain.token1 },
      safety: strategy.marketSafety, lastSwap: strategy.lastSwap,
      latestBlock: chain.latestBlock, allowedRouters: config.allowedRouters, rpc,
      maxSwapAgeBlocks: config.sellProbeMaxSwapAgeBlocks,
      maxSlippageBps: config.sellProbeMaxSlippageBps,
      atlasWalletAddress: config.walletAddress,
      maxStorageSlot: config.sellProbeMaxStorageSlot,
      negativeCacheMs: config.sellProbeNegativeCacheMs,
      nowSeconds: Math.floor(now / 1_000) });
  };
}
