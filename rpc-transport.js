function normalizeUrls(urls) {
  return [...new Set((urls || []).map((url) => String(url).trim()).filter(Boolean))];
}

function retryableStatus(status) {
  return status === 401 || status === 403 || status === 408 || status === 429 || status >= 500;
}

export function rpcUrlsFromEnv({ primary, fallbacks = "", defaultUrl }) {
  return normalizeUrls([
    primary || defaultUrl,
    ...String(fallbacks).split(/[\s,]+/),
  ]);
}

export class RpcTransport {
  constructor({ urls, fetchImpl = fetch, timeoutMs = 12_000, cooldownMs = 60_000,
    now = Date.now } = {}) {
    this.urls = normalizeUrls(urls);
    if (!this.urls.length) throw new Error("at least one RPC URL is required");
    this.fetchImpl = fetchImpl;
    this.timeoutMs = Math.max(1, Number(timeoutMs) || 12_000);
    this.cooldownMs = Math.max(0, Number(cooldownMs) || 0);
    this.now = now;
    this.activeIndex = 0;
    this.cooldowns = new Map();
    this.requestCount = 0;
    this.failureCount = 0;
    this.failoverCount = 0;
  }

  candidateIndexes() {
    const now = this.now();
    const ordered = Array.from({ length: this.urls.length }, (_, offset) =>
      (this.activeIndex + offset) % this.urls.length);
    const ready = ordered.filter((index) => (this.cooldowns.get(index) || 0) <= now);
    if (ready.includes(0) && this.activeIndex !== 0) {
      return [0, ...ready.filter((index) => index !== 0)];
    }
    return ready.length ? ready : [ordered.reduce((best, index) =>
      ((this.cooldowns.get(index) || 0) < (this.cooldowns.get(best) || 0) ? index : best))];
  }

  async request(method, params) {
    this.requestCount += 1;
    const errors = [];
    for (const index of this.candidateIndexes()) {
      try {
        const response = await this.fetchImpl(this.urls[index], {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!response.ok) {
          const error = new Error(`RPC HTTP ${response.status}`);
          error.retryable = retryableStatus(response.status);
          throw error;
        }
        const body = await response.json();
        if (body.error) {
          const error = new Error(`RPC: ${body.error.message}`);
          error.retryable = false;
          throw error;
        }
        if (index !== this.activeIndex) this.failoverCount += 1;
        this.activeIndex = index;
        this.cooldowns.delete(index);
        return body.result;
      } catch (error) {
        this.failureCount += 1;
        errors.push(error instanceof Error ? error.message : String(error));
        const retryable = error?.retryable !== false;
        if (!retryable) break;
        this.cooldowns.set(index, this.now() + this.cooldownMs);
      }
    }
    throw new Error(`RPC endpoints unavailable: ${errors.join("; ")}`);
  }

  snapshot() {
    const now = this.now();
    return {
      endpointCount: this.urls.length,
      activeEndpoint: this.activeIndex + 1,
      requestCount: this.requestCount,
      failureCount: this.failureCount,
      failoverCount: this.failoverCount,
      coolingDown: [...this.cooldowns.values()].filter((until) => until > now).length,
    };
  }
}
