const finite = (value) => Number.isFinite(Number(value));

export const SHADOW_RULES = Object.freeze([
  { name: "escape-strict", signal: "escape-velocity", maxDeviationPct: 5 },
  { name: "escape-relaxed", signal: "escape-velocity", maxDeviationPct: 10 },
  { name: "breakout-strict", signal: "breakout-watch", maxDeviationPct: 5 },
]);

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

export class ShadowEvaluator {
  constructor({ horizonMs = 5 * 60 * 1000, rules = SHADOW_RULES } = {}) {
    this.horizonMs = horizonMs;
    this.rules = rules;
    this.samples = [];
  }

  observe(candidates, now = Date.now()) {
    const prices = new Map(candidates
      .filter((candidate) => finite(candidate?.marketSafety?.tokenPriceQuote))
      .map((candidate) => [candidate.address, Number(candidate.marketSafety.tokenPriceQuote)]));
    for (const sample of this.samples) {
      if (sample.closedAt || now - sample.openedAt < this.horizonMs) continue;
      const exitPrice = prices.get(sample.pool);
      if (!finite(exitPrice) || exitPrice <= 0) continue;
      sample.closedAt = now;
      sample.exitPrice = exitPrice;
      sample.returnPct = ((exitPrice / sample.entryPrice) - 1) * 100;
    }

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
          openedAt: now,
        });
      }
    }
    if (this.samples.length > 2000) this.samples = this.samples.slice(-2000);
  }

  snapshot() {
    const byRule = {};
    for (const rule of this.rules) {
      const closed = this.samples.filter((sample) => sample.rule === rule.name && sample.closedAt);
      const wins = closed.filter((sample) => sample.returnPct > 0).length;
      byRule[rule.name] = {
        openSamples: this.samples.filter((sample) => sample.rule === rule.name && !sample.closedAt).length,
        closedSamples: closed.length,
        winRatePct: closed.length ? wins / closed.length * 100 : 0,
        averageReturnPct: closed.length
          ? closed.reduce((sum, sample) => sum + sample.returnPct, 0) / closed.length : 0,
      };
    }
    return { mode: "SHADOW_ONLY", horizonMs: this.horizonMs, byRule,
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
