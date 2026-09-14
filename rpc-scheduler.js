const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function nextBackoffMs({ currentMs, rateLimited, baseMs = 5_000 }) {
  const current = Math.max(Number(currentMs) || baseMs, baseMs);
  return rateLimited
    ? Math.min(Math.max(current * 2, 15_000), 120_000)
    : Math.min(Math.max(current * 2, baseMs), 30_000);
}

export function isRpcThrottleError(error) {
  return /RPC HTTP (403|429)/.test(String(error?.message || error));
}

export class RpcScheduler {
  constructor({ minIntervalMs = 250, jitterMs = 100, random = Math.random } = {}) {
    this.minIntervalMs = Math.max(0, Number(minIntervalMs) || 0);
    this.jitterMs = Math.max(0, Number(jitterMs) || 0);
    this.random = random;
    this.nextAllowedAt = 0;
    this.queue = Promise.resolve();
    this.requestCount = 0;
    this.rateLimitCount = 0;
  }

  schedule(task) {
    const run = this.queue.then(async () => {
      const delay = Math.max(0, this.nextAllowedAt - Date.now());
      if (delay) await wait(delay);
      this.requestCount += 1;
      try {
        return await task();
      } catch (error) {
        if (String(error?.message || error).includes("429")) {
          this.rateLimitCount += 1;
          this.nextAllowedAt = Math.max(this.nextAllowedAt, Date.now() + 15_000);
        }
        throw error;
      } finally {
        const jitter = Math.floor(this.random() * (this.jitterMs + 1));
        this.nextAllowedAt = Math.max(this.nextAllowedAt, Date.now() + this.minIntervalMs + jitter);
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  snapshot() {
    return {
      minIntervalMs: this.minIntervalMs,
      jitterMs: this.jitterMs,
      requestCount: this.requestCount,
      rateLimitCount: this.rateLimitCount,
      cooldownMs: Math.max(0, this.nextAllowedAt - Date.now()),
    };
  }
}
