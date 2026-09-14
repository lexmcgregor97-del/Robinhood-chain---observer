const finite = (value) => Number.isFinite(Number(value));

export const SHADOW_RULES = Object.freeze([
  { name: "escape-strict", signal: "escape-velocity", maxDeviationPct: 5 },
  { name: "escape-relaxed", signal: "escape-velocity", maxDeviationPct: 10 },
  { name: "escape-confirmed", signal: "escape-velocity", maxDeviationPct: 5,
    confirmationCycles: 2 },
  { name: "steady-accumulation", signal: "active", minSwaps: 4,
    minAcceleration: 0.75, maxAcceleration: 1.5, maxDeviationPct: 5 },
  { name: "activity-baseline", signals: ["active", "breakout-watch", "escape-velocity"],
    minSwaps: 3, maxDeviationPct: 5 },
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
  const signal = candidate?.signal || {};
  const acceptedSignals = rule.signals || [rule.signal];
  return acceptedSignals.includes(signal.state)
    && (!finite(rule.minSwaps) || Number(signal.swapsCurrentWindow) >= Number(rule.minSwaps))
    && (!finite(rule.minAcceleration)
      || Number(signal.acceleration) >= Number(rule.minAcceleration))
    && (!finite(rule.maxAcceleration)
      || Number(signal.acceleration) <= Number(rule.maxAcceleration))
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
  constructor({ horizonMs, horizonsMs = [60_000, 5 * 60_000, 15 * 60_000],
    rules = SHADOW_RULES } = {}) {
    this.horizonsMs = horizonMs ? [horizonMs] : horizonsMs;
    this.horizonMs = this.horizonsMs.includes(5 * 60_000)
      ? 5 * 60_000 : this.horizonsMs[0];
    this.rules = rules;
    this.samples = [];
    this.confirmations = new Map();
  }

  pendingPoolAddresses() {
    return [...new Set(this.samples
      .filter((sample) => !sample.closedAt && !sample.resolutionFailedAt)
      .map((sample) => sample.pool))];
  }

  resolve(candidates, now = Date.now()) {
    const prices = new Map(candidates
      .filter((candidate) => finite(candidate?.marketSafety?.tokenPriceQuote))
      .map((candidate) => [candidate.address, Number(candidate.marketSafety.tokenPriceQuote)]));
    for (const sample of this.samples) {
      const sampleHorizonMs = Number(sample.horizonMs || this.horizonMs);
      if (sample.closedAt || sample.resolutionFailedAt
          || now - sample.openedAt < sampleHorizonMs) continue;
      const exitPrice = prices.get(sample.pool);
      if (!finite(exitPrice) || exitPrice <= 0) {
        if (now - sample.openedAt >= sampleHorizonMs * 3) {
          sample.resolutionFailedAt = now;
          sample.grossReturnPct = -100;
          sample.netReturnPct = -100;
          sample.returnPct = -100;
        }
        continue;
      }
      sample.closedAt = now;
      sample.exitPrice = exitPrice;
      sample.grossReturnPct = ((exitPrice / sample.entryPrice) - 1) * 100;
      sample.netReturnPct = sample.grossReturnPct - Number(sample.executionCostPct || 0);
      sample.returnPct = sample.netReturnPct;
    }
  }

  record(candidates, now = Date.now()) {
    const observedConfirmationKeys = new Set();
    for (const candidate of candidates) {
      for (const rule of this.rules) {
        if (!shadowRuleMatches(candidate, rule)) continue;
        const confirmationKey = `${rule.name}:${candidate.address}`;
        const requiredCycles = Number(rule.confirmationCycles || 1);
        if (requiredCycles > 1) {
          observedConfirmationKeys.add(confirmationKey);
          const count = Number(this.confirmations.get(confirmationKey) || 0) + 1;
          this.confirmations.set(confirmationKey, count);
          if (count < requiredCycles) continue;
        }
        let recorded = false;
        for (const horizonMs of this.horizonsMs) {
          const duplicate = this.samples.some((sample) => !sample.closedAt
            && !sample.resolutionFailedAt && sample.rule === rule.name
            && sample.pool === candidate.address
            && Number(sample.horizonMs || this.horizonMs) === horizonMs);
          if (duplicate) continue;
          this.samples.push({
            rule: rule.name,
            horizonMs,
            pool: candidate.address,
            quoteToken: candidate.marketSafety.quoteToken,
            entryPrice: Number(candidate.marketSafety.tokenPriceQuote),
            executionCostPct: Number(candidate.marketSafety.roundTripLossPct),
            openedAt: now,
          });
          recorded = true;
        }
        if (recorded && requiredCycles > 1) this.confirmations.set(confirmationKey, 0);
      }
    }
    for (const key of this.confirmations.keys()) {
      if (!observedConfirmationKeys.has(key)) this.confirmations.delete(key);
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
      const byHorizon = {};
      for (const horizonMs of this.horizonsMs) {
        const matching = this.samples.filter((sample) => sample.rule === rule.name
          && Number(sample.horizonMs || this.horizonMs) === horizonMs);
        const closed = matching.filter((sample) => sample.closedAt || sample.resolutionFailedAt);
        const summary = summarizeSamples(closed);
        byHorizon[String(horizonMs)] = {
          openSamples: matching.filter((sample) => !sample.closedAt
            && !sample.resolutionFailedAt).length,
          resolutionFailures: closed.filter((sample) => sample.resolutionFailedAt).length,
          ...summary,
          promotion: evaluateShadowPromotion(summary),
        };
      }
      const primary = byHorizon[String(this.horizonMs)];
      byRule[rule.name] = { ...primary, byHorizon };
    }
    return { mode: "SHADOW_ONLY", horizonMs: this.horizonMs,
      horizonsMs: this.horizonsMs,
      promotionPolicy: DEFAULT_PROMOTION_POLICY, byRule,
      recentSamples: this.samples.slice(-50) };
  }

  serialize() {
    return { horizonMs: this.horizonMs, horizonsMs: this.horizonsMs,
      samples: this.samples, confirmations: Object.fromEntries(this.confirmations) };
  }

  restore(state) {
    if (!state || !Array.isArray(state.samples)) return;
    this.samples = state.samples.slice(-2000).map((sample) => ({
      ...sample,
      horizonMs: Number(sample.horizonMs || state.horizonMs || 5 * 60_000),
    }));
    this.confirmations = new Map(Object.entries(state.confirmations || {}));
  }
}
