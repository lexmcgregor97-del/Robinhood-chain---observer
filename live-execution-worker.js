import { buildLiveV2BuyIntent, buildLiveV2SellIntent } from "./live-v2-intent.js";
import { liveExitReason, quoteLivePositionExit } from "./live-exit-policy.js";
import { settlementFromExecutionRecord } from "./live-position-settlement.js";
import { buildLiveExitApprovalIntent } from "./live-approval-intent.js";

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
  constructor({ source, inspectCandidate, inspectPosition = inspectCandidate, lifecycle,
    submitExit, submitApproval, probeExit, journal, positions, plans, config }) {
    if (!source || typeof source.fetchCandidates !== "function"
        || typeof inspectCandidate !== "function" || !lifecycle
        || typeof inspectPosition !== "function" || typeof submitExit !== "function"
        || typeof submitApproval !== "function"
        || typeof probeExit !== "function"
        || !journal || !positions || !(plans instanceof Map) || !config) {
      throw new Error("invalid-live-worker-config");
    }
    this.source = source;
    this.inspectCandidate = inspectCandidate;
    this.inspectPosition = inspectPosition;
    this.lifecycle = lifecycle;
    this.submitExit = submitExit;
    this.submitApproval = submitApproval;
    this.probeExit = probeExit;
    this.journal = journal;
    this.positions = positions;
    this.plans = plans;
    this.config = config;
    this.running = false;
  }

  async reconcilePositions(now) {
    const records = this.journal.snapshot().records || [];
    for (const record of records) {
      if (record.status === "confirmed"
          && new Set(["live-v2-buy", "live-v2-sell"]).has(record.intentPurpose)
          && !this.positions.hasProcessed(record.intentId)) {
        const settlement = settlementFromExecutionRecord(record, { walletAddress: this.config.walletAddress,
          wethAddress: this.config.wethAddress });
        if (settlement.side === "buy") {
          const snapshot = await this.inspectPosition({ poolAddress: settlement.transferSource,
            baseToken: settlement.baseToken, routerAddress: settlement.routerAddress },
          { phase: "settlement", now });
          await this.positions.open({ poolAddress: settlement.transferSource,
            baseToken: settlement.baseToken, routerAddress: settlement.routerAddress,
            baseUnits: settlement.receivedUnits, entryWethWei: settlement.amountIn,
            feeBps: snapshot.feeBps, entryIntentId: record.intentId,
            entryTransactionHash: record.transactionHash, entryBlock: settlement.blockNumber,
            openedAt: Number(record.updatedAt || now) }, now);
        } else {
          const position = this.positions.openPositions()
            .find((item) => item.exitIntentId === record.intentId);
          if (!position) throw new Error("live-settlement-position-missing");
          await this.positions.close(position.poolAddress, { intentId: record.intentId,
            transactionHash: record.transactionHash, wethReceivedWei: settlement.receivedUnits }, now);
        }
      }
      if (record.status === "reverted") {
        const position = this.positions.openPositions()
          .find((item) => item.status === "exit-requested" && item.exitIntentId === record.intentId);
        if (position) await this.positions.cancelExit(position.poolAddress, record.intentId, now);
      }
    }
    for (const position of this.positions.openPositions()) {
      if (position.status !== "exit-requested") continue;
      const record = this.journal.get(position.exitIntentId);
      if (!record || new Set(["rejected", "reverted", "operator-rejected"]).has(record.status)) {
        await this.positions.cancelExit(position.poolAddress, position.exitIntentId, now);
      }
    }
  }

  async runOnce({ now = Date.now() } = {}) {
    if (this.running) return Object.freeze({ status: "skipped", reason: "worker-cycle-running" });
    this.running = true;
    try {
      await this.lifecycle.recoverPending({ now });
      if (this.journal.pending().length) {
        return Object.freeze({ status: "blocked", reason: "pending-execution-review-required" });
      }
      await this.reconcilePositions(now);
      const position = this.positions.openPositions()[0];
      if (position) {
        if (position.status === "exit-requested") {
          return Object.freeze({ status: "blocked", reason: "exit-settlement-required" });
        }
        const snapshot = await this.inspectPosition(position, { phase: "exit-construction", now });
        const observedAllowance = BigInt(snapshot.baseAllowanceWei || "0");
        const approvalAmount = observedAllowance > 0n && observedAllowance !== BigInt(position.baseUnits)
          ? "0" : position.baseUnits;
        const approvalIntent = buildLiveExitApprovalIntent({ position, snapshot,
          config: this.config, amountWei: approvalAmount, now });
        if (observedAllowance !== BigInt(position.baseUnits)) {
          if (this.journal.get(approvalIntent.id)?.status === "confirmed") {
            return Object.freeze({ status: "blocked", reason: "exit-approval-state-divergence" });
          }
          const result = await this.submitApproval(approvalIntent, position, { now });
          return Object.freeze({ status: "approval-submitted", intentId: approvalIntent.id, result });
        }
        const currentWethOutWei = quoteLivePositionExit(position, snapshot);
        const marked = await this.positions.mark(position.poolAddress, currentWethOutWei, now);
        const intent = buildLiveV2SellIntent({ position: marked, snapshot, config: this.config,
          slippageBps: this.config.slippageBps, deadlineSeconds: this.config.deadlineSeconds, now });
        const exitProbe = await this.probeExit(intent, marked, { now });
        if (exitProbe?.approved !== true) return Object.freeze({ status: "blocked",
          reason: "live-exit-probe-failed", failures: exitProbe?.failures || [] });
        const reason = liveExitReason(marked, currentWethOutWei, now, this.config.exitPolicy);
        if (!reason) return Object.freeze({ status: "holding", poolAddress: position.poolAddress });
        await this.positions.requestExit(position.poolAddress, { reason, intentId: intent.id }, now);
        this.plans.set(intent.id, frozenPlan({ dex: position.dex,
          discoveryBlock: position.discoveryBlock }, { ...snapshot, strategyApproved: true }));
        try {
          const result = await this.submitExit(intent, marked, { now });
          if (result?.status === "rejected") {
            await this.positions.cancelExit(position.poolAddress, intent.id, now);
          } else if (result?.status === "confirmed") await this.reconcilePositions(now);
          return Object.freeze({ status: "exit-submitted", intentId: intent.id, reason, result });
        } finally { this.plans.delete(intent.id); }
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
