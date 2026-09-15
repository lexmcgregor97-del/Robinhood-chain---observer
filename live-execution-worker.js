import { buildLiveV2BuyIntent } from "./live-v2-intent.js";

const frozenPlan = (candidate, snapshot) => Object.freeze({
  poolAddress: String(snapshot.poolAddress).toLowerCase(),
  token0: String(snapshot.token0).toLowerCase(),
  token1: String(snapshot.token1).toLowerCase(),
  baseToken: (String(snapshot.token0).toLowerCase() === String(snapshot.wethAddress || "").toLowerCase()
    ? String(snapshot.token1) : String(snapshot.token0)).toLowerCase(),
  dex: String(candidate.dex || ""),
  discoveryBlock: Number(candidate.discoveryBlock),
  feeBps: Number(snapshot.feeBps),
  strategyApproved: snapshot.strategyApproved === true,
});

export class LiveExecutionWorker {
  constructor({ source, inspectCandidate, lifecycle, journal, plans, config }) {
    if (!source || typeof source.fetchCandidates !== "function"
        || typeof inspectCandidate !== "function" || !lifecycle
        || !journal || !(plans instanceof Map) || !config) {
      throw new Error("invalid-live-worker-config");
    }
    this.source = source;
    this.inspectCandidate = inspectCandidate;
    this.lifecycle = lifecycle;
    this.journal = journal;
    this.plans = plans;
    this.config = config;
    this.running = false;
  }

  async runOnce({ now = Date.now() } = {}) {
    if (this.running) return Object.freeze({ status: "skipped", reason: "worker-cycle-running" });
    this.running = true;
    try {
      if (this.journal.pending().length) {
        return Object.freeze({ status: "blocked", reason: "pending-execution-review-required" });
      }
      const candidates = await this.source.fetchCandidates();
      if (!Array.isArray(candidates)) throw new Error("candidate-source-invalid");
      for (const rawCandidate of candidates) {
        const candidate = Object.freeze({ version: rawCandidate?.version,
          dex: rawCandidate?.dex, address: rawCandidate?.address,
          token0: rawCandidate?.token0, token1: rawCandidate?.token1,
          discoveryBlock: rawCandidate?.discoveryBlock,
          router: this.config.routerAddress });
        const snapshot = await this.inspectCandidate(candidate, { phase: "construction", now });
        if (snapshot?.strategyApproved !== true) continue;
        const intent = buildLiveV2BuyIntent({ candidate, snapshot, config: this.config,
          amountInWei: this.config.amountInWei, slippageBps: this.config.slippageBps,
          deadlineSeconds: this.config.deadlineSeconds, now });
        this.plans.set(intent.id, frozenPlan(candidate, snapshot));
        try {
          const result = await this.lifecycle.submit(intent, { now });
          return Object.freeze({ status: "submitted", intentId: intent.id, result });
        } finally {
          this.plans.delete(intent.id);
        }
      }
      return Object.freeze({ status: "idle", reason: "no-independently-approved-candidate" });
    } finally {
      this.running = false;
    }
  }
}

export function createObserverCandidateSource({ url, expectedHostname, bearerToken,
  fetchImpl = fetch, timeoutMs = 5_000 } = {}) {
  const endpoint = new URL("/api/live-worker/candidates", url);
  if (endpoint.protocol !== "https:" && endpoint.hostname !== "localhost") {
    throw new Error("observer-candidate-source-https-required");
  }
  if (!expectedHostname || endpoint.hostname.toLowerCase() !== String(expectedHostname).toLowerCase()) {
    throw new Error("observer-candidate-hostname-mismatch");
  }
  if (String(bearerToken || "").length < 32) throw new Error("observer-candidate-auth-required");
  return Object.freeze({
    async fetchCandidates() {
      const response = await fetchImpl(endpoint, { method: "GET",
        headers: { accept: "application/json", authorization: `Bearer ${bearerToken}` },
        signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error("observer-candidate-source-failed");
      const body = await response.json();
      if (body?.mode !== "PAPER_FAIL_CLOSED" || !Array.isArray(body.candidates)) {
        throw new Error("observer-candidate-source-invalid");
      }
      return body.candidates;
    },
  });
}
