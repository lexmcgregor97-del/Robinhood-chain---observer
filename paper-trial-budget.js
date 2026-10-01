export class PaperTrialBudget {
  constructor({ state, maxRequests = 10_000, maxDurationMs = 2 * 60 * 60_000,
    noProgressMs = 30 * 60_000, now = Date.now, persist }) {
    for (const n of [maxRequests, maxDurationMs, noProgressMs]) {
      if (!Number.isSafeInteger(n) || n <= 0) throw new Error("invalid-paper-trial-limit");
    }
    if (typeof persist !== "function") throw new Error("paper-trial-persistence-required");
    this.now = now;
    this.persist = persist;
    this.queue = Promise.resolve();
    this.limits = { maxRequests, maxDurationMs, noProgressMs };
    if (state && (!Number.isSafeInteger(state.requests) || state.requests < 0
        || !Number.isFinite(state.startedAt) || !Number.isFinite(state.lastProgressAt)
        || state.startedAt > now() || state.lastProgressAt > now())) {
      throw new Error("invalid-paper-trial-checkpoint");
    }
    this.state = state ? structuredClone(state)
      : { requests: 0, startedAt: now(), lastProgressAt: now(), halted: null };
  }
  reason() {
    return this.state.halted
      || (this.state.requests >= this.limits.maxRequests ? "paper-rpc-budget-exhausted" : null)
      || (this.now() - this.state.startedAt >= this.limits.maxDurationMs ? "paper-trial-time-limit" : null)
      || (this.now() - this.state.lastProgressAt >= this.limits.noProgressMs ? "paper-trial-no-entry-progress" : null);
  }
  snapshot() { return { ...this.state, ...this.limits, halted: this.reason() }; }
  mutate(fn) {
    const result = this.queue.then(async () => {
      if (this.reason()) this.state.halted = this.reason();
      fn();
      try { await this.persist({ ...this.state }); }
      catch { this.state.halted = "paper-trial-persistence-failed"; }
      if (this.state.halted) throw new Error(this.state.halted);
    });
    this.queue = result.catch(() => {});
    return result;
  }
  beforeAttempt() {
    return this.mutate(() => { if (!this.state.halted) this.state.requests += 1; });
  }
  progress() {
    return this.mutate(() => { if (!this.state.halted) this.state.lastProgressAt = this.now(); });
  }
  check() { return this.mutate(() => {}); }
}
