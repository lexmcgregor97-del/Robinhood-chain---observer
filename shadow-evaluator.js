const finite = (value) => Number.isFinite(Number(value));

export const SHADOW_RULES = Object.freeze([
  { name: "escape-strict", signal: "escape-velocity", maxDeviationPct: 5 },
  { name: "escape-relaxed", signal: "escape-velocity", maxDeviationPct: 10 },
  { name: "breakout-strict", signal: "breakout-watch", maxDeviationPct: 5 },
]);

export const DEFAULT_PROMOTION_POLICY = Object.freeze({
  minClosedSamples: 30,
  minAverageReturnPct: 2,
  minMedianReturnPct: 0,
  minWinRatePct: 45,
  maxCumulativeDrawdownPct: 25,
});

export function shadowRuleMatches(candidate, rule) {
  const safety = candidate?.marketSafety || {};
  return candidate?.signal?.state === rule.signal
    && safety.quoteTokenKnown === true
    && safety.liquidityKnown === true
    && safety.buySimulationOk === true
    && safety.sellSimulationOk === true
    && safety.priceAuditAvailable === true
    && finite(safety.tokenPriceQuote) && Number(safety.tokenPriceQuote) > 0
    && finite(safety.priceImpactPct) && Number(safety.priceImpactPct) <= 5
    && finite(safety.roundTripLossPct) && Number(safety.roundTripLossPct) <= 15
    && finite(safety.spotVsLastSwapPct)
    && Number(safety.spotVsLastSwapPct) <= rule.maxDeviationPct;
}

function summarizeSamples(samples) {
  const returns = samples.map((sample) => Number(sample.netReturnPct ?? sample.returnPct))
    .filter(Number.isFinite);
  const sorted = [...returns].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const medianReturnPct = sorted.length
    ? (sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2) : 0;
  let cumulative = 0;
  let peak = 0;
  let maxCumulativeDrawdownPct = 0;
  for (const value of returns) {
    cumulative += value;
    peak = Math.max(peak, cumulative);
    maxCumulativeDrawdownPct = Math.max(maxCumulativeDrawdownPct, peak - cumulative);
  }
  const wins = returns.filter((value) => value > 0).length;
  return {
    closedSamples: returns.length,
    winRatePct: returns.length ? wins / returns.length * 100 : 0,
    averageReturnPct: returns.length
      ? returns.reduce((sum, value) => sum + value, 0) / returns.length : 0,
    medianReturnPct,
    maxCumulativeDrawdownPct,
  };
}

export function evaluateShadowPromotion(summary, policy = DEFAULT_PROMOTION_POLICY) {
  if (summary.closedSamples < policy.minClosedSamples) {
    return {
      status: "collecting",
      eligible: false,
      remainingSamples: policy.minClosedSamples - summary.closedSamples,
      failures: ["insufficient-samples"],
    };
  }
  const failures = [];
  if (summary.averageReturnPct < policy.minAverageReturnPct) failures.push("average-return-too-low");
  if (summary.medianReturnPct < policy.minMedianReturnPct) failures.push("median-return-too-low");
  if (summary.winRatePct < policy.minWinRatePct) failures.push("win-rate-too-low");
  if (summary.maxCumulativeDrawdownPct > policy.maxCumulativeDrawdownPct) {
    failures.push("shadow-drawdown-too-high");
  }
  return {
    status: failures.length ? "rejected" : "promotion-candidate",
    eligible: failures.length === 0,
    remainingSamples: 0,
    failures,
  };
}

export class ShadowEvaluator {
  constructor({ horizonMs = 5 * 60 * 1000, rules = SHADOW_RULES } = {}) {
    this.horizonMs = horizonMs;
    this.rules = rules;
    this.samples = [];
  }

  pendingPoolAddresses() {
    return [...new Set(this.samples
      .filter((sample) => !sample.closedAt)
      .map((sample) => sample.pool))];
  }

  resolve(candidates, now = Date.now()) {
    const prices = new Map(candidates
      .filter((candidate) => finite(candidate?.marketSafety?.tokenPriceQuote))
      .map((candidate) => [candidate.address, Number(candidate.marketSafety.tokenPriceQuote)]));
    for (const sample of this.samples) {
      if (sample.closedAt || now - sample.openedAt < this.horizonMs) continue;
      const exitPrice = prices.get(sample.pool);
      if (!finite(exitPrice) || exitPrice <= 0) continue;
      sample.closedAt = now;
      sample.exitPrice = exitPrice;
      sample.grossReturnPct = ((exitPrice / sample.entryPrice) - 1) * 100;
      sample.netReturnPct = sample.grossReturnPct - Number(sample.executionCostPct || 0);
      sample.returnPct = sample.netReturnPct;
    }
  }

  record(candidates, now = Date.now()) {
    for (const candidate of candidates) {
      for (const rule of this.rules) {
        if (!shadowRuleMatches(candidate, rule)) continue;
        const duplicate = this.samples.some((sample) => !sample.closedAt
          && sample.rule === rule.name && sample.pool === candidate.address);
        if (duplicate) continue;
        this.samples.push({
          rule: rule.name,
          pool: candidate.address,
          quoteToken: candidate.marketSafety.quoteToken,
          entryPrice: Number(candidate.marketSafety.tokenPriceQuote),
          executionCostPct: Number(candidate.marketSafety.roundTripLossPct),
          openedAt: now,
        });
      }
    }
    if (this.samples.length > 2000) this.samples = this.samples.slice(-2000);
  }

  observe(candidates, now = Date.now()) {
    this.resolve(candidates, now);
    this.record(candidates, now);
  }

  snapshot() {
    const byRule = {};
    for (const rule of this.rules) {
      const closed = this.samples.filter((sample) => sample.rule === rule.name && sample.closedAt);
      const summary = summarizeSamples(closed);
      byRule[rule.name] = {
        openSamples: this.samples.filter((sample) => sample.rule === rule.name && !sample.closedAt).length,
        ...summary,
        promotion: evaluateShadowPromotion(summary),
      };
    }
    return { mode: "SHADOW_ONLY", horizonMs: this.horizonMs,
      promotionPolicy: DEFAULT_PROMOTION_POLICY, byRule,
      recentSamples: this.samples.slice(-50) };
  }

  serialize() {
    return { horizonMs: this.horizonMs, samples: this.samples };
  }

  restore(state) {
    if (!state || !Array.isArray(state.samples)) return;
    this.samples = state.samples.slice(-2000);
  }
}
