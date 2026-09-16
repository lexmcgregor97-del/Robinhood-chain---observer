import { probeTurnkeySigningPolicy } from "./turnkey-signing-probe.js";
import { probeV2Sell } from "./v2-sell-probe.js";

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
        signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error();
      const body = await response.json();
      const responseValid = body?.mode === "PAPER_ONLY"
        && typeof body?.newEntriesPaused === "boolean"
        && (body?.automationBlockedReason == null
          || typeof body.automationBlockedReason === "string")
        && typeof body?.automation === "object"
        && typeof body?.evidence?.healthy === "boolean"
        && Number.isSafeInteger(body?.execution?.durability?.pendingExecutions)
        && typeof body?.execution?.signingVerification?.attestationVerified === "boolean"
        && typeof body?.liveReadiness?.eligibleForMicroMainnet === "boolean";
      if (!responseValid) return Object.freeze({
        endpointAuthenticated: true, responseValid: false,
        eligibleForMicroMainnet: false,
        failures: Object.freeze(["observer-live-readiness-invalid"]),
      });
      const lastCycleAt = Number(body?.automation?.lastCycleAt);
      const fresh = Number.isSafeInteger(lastCycleAt) && lastCycleAt <= now
        && now - lastCycleAt <= maxAgeMs;
      const eligible = body?.mode === "PAPER_ONLY" && body?.newEntriesPaused !== true
        && body?.automationBlockedReason == null && body?.evidence?.healthy === true
        && body?.execution?.durability?.pendingExecutions === 0
        && body?.execution?.signingVerification?.attestationVerified === true
        && body?.liveReadiness?.eligibleForMicroMainnet === true && fresh;
      return Object.freeze({ endpointAuthenticated: true, responseValid: true,
        eligibleForMicroMainnet: eligible,
        failures: eligible ? Object.freeze([])
          : Object.freeze(["observer-live-readiness-not-current"]) });
    } catch {
      return Object.freeze({ endpointAuthenticated: false, responseValid: false,
        eligibleForMicroMainnet: false,
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
