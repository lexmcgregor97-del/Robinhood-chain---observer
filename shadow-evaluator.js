const finite = (value) => Number.isFinite(Number(value));
const FIVE_MINUTES = 5 * 60_000;
const RULE_VERSION = "2026-09-14-measurement-v2";

export const SHADOW_RULES = Object.freeze([
  { name: "escape-activity", signal: "escape-velocity", maxDeviationPct: 5 },
  { name: "steady-accumulation", signal: "active", minSwaps: 4,
    minAcceleration: 0.75, maxAcceleration: 1.5, maxDeviationPct: 5 },
  { name: "activity-pullback", signals: ["active", "breakout-watch", "escape-velocity"],
    minSwaps: 3, maxDeviationPct: 5, pullbackMinPct: 2, pullbackMaxPct: 12,
    setupMaxAgeMs: FIVE_MINUTES },
]);

export const DEFAULT_PROMOTION_POLICY = Object.freeze({
  minUniquePools: 20,
  minMedianReturnPct: 0,
  minMeanCiLowerPct: 0,
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
    && safety.buyMathOk === true
    && safety.sellMathOk === true
    && safety.priceAuditAvailable === true
    && finite(safety.tokenPriceQuote) && Number(safety.tokenPriceQuote) > 0
    && finite(safety.priceImpactPct) && Number(safety.priceImpactPct) <= 5
    && finite(safety.executionCostPct) && Number(safety.executionCostPct) <= 15
    && finite(safety.spotVsLastSwapPct)
    && Number(safety.spotVsLastSwapPct) <= rule.maxDeviationPct;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function poolBootstrapLower(samples, iterations = 1000) {
  const byPool = new Map();
  for (const sample of samples) {
    const values = byPool.get(sample.pool) || [];
    values.push(Number(sample.netReturnPct));
    byPool.set(sample.pool, values);
  }
  const pools = [...byPool.values()];
  if (pools.length < 2) return null;
  const random = seededRandom(0x5eed1234);
  const means = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const values = [];
    for (let index = 0; index < pools.length; index += 1) {
      const selected = pools[Math.floor(random() * pools.length)];
      values.push(...selected);
    }
    means.push(values.reduce((sum, value) => sum + value, 0) / values.length);
  }
  means.sort((a, b) => a - b);
  return means[Math.floor(means.length * 0.025)];
}

function summarizeSamples(samples) {
  const resolved = samples.filter((sample) => sample.closedAt
    && finite(sample.netReturnPct));
  const returns = resolved.map((sample) => Number(sample.netReturnPct));
  const uniquePools = new Set(resolved.map((sample) => sample.pool)).size;
  const wins = returns.filter((value) => value > 0).length;
  return {
    closedSamples: returns.length,
    uniquePools,
    censoredSamples: samples.filter((sample) => sample.censoredAt).length,
    winRatePct: returns.length ? wins / returns.length * 100 : 0,
    averageReturnPct: returns.length
      ? returns.reduce((sum, value) => sum + value, 0) / returns.length : 0,
    medianReturnPct: median(returns),
    meanCiLowerPct: poolBootstrapLower(resolved),
  };
}

export function evaluateShadowPromotion(summary, policy = DEFAULT_PROMOTION_POLICY) {
  if (summary.uniquePools < policy.minUniquePools) {
    return {
      status: "collecting",
      eligible: false,
      remainingUniquePools: policy.minUniquePools - summary.uniquePools,
      failures: ["insufficient-unique-pools"],
    };
  }
  const failures = [];
  if (summary.medianReturnPct <= policy.minMedianReturnPct) {
    failures.push("median-return-too-low");
  }
  if (!finite(summary.meanCiLowerPct)
      || summary.meanCiLowerPct <= policy.minMeanCiLowerPct) {
    failures.push("mean-confidence-bound-too-low");
  }
  return {
    status: failures.length ? "rejected" : "promotion-candidate",
    eligible: failures.length === 0,
    remainingUniquePools: 0,
    failures,
  };
}

export class ShadowEvaluator {
  constructor({
    horizonMs = FIVE_MINUTES,
    episodeGapMs = FIVE_MINUTES,
    resolutionTimeoutMultiplier = 3,
    rules = SHADOW_RULES,
  } = {}) {
    this.horizonMs = horizonMs;
    this.horizonsMs = [horizonMs];
    this.episodeGapMs = episodeGapMs;
    this.resolutionTimeoutMultiplier = resolutionTimeoutMultiplier;
    this.rules = rules;
    this.samples = [];
    this.episodes = new Map();
    this.pullbackSetups = new Map();
  }

  pendingPoolAddresses() {
    return [...new Set(this.samples
      .filter((sample) => !sample.closedAt && !sample.censoredAt)
      .map((sample) => sample.pool))];
  }

  resolve(candidates, now = Date.now()) {
    const measurements = new Map(candidates.map((candidate) => [
      candidate.address, candidate.marketSafety || {},
    ]));
    for (const sample of this.samples) {
      if (sample.closedAt || sample.censoredAt
          || now - sample.openedAt < this.horizonMs) continue;
      const safety = measurements.get(sample.pool);
      const exitPrice = Number(safety?.tokenPriceQuote);
      if (!finite(exitPrice) || exitPrice <= 0) {
        if (now - sample.openedAt >= this.horizonMs * this.resolutionTimeoutMultiplier) {
          sample.censoredAt = now;
          sample.censorReason = "price-unavailable";
        }
        continue;
      }
      sample.closedAt = now;
      sample.exitPrice = exitPrice;
      sample.grossReturnPct = ((exitPrice / sample.entryPrice) - 1) * 100;
      sample.netReturnPct = sample.grossReturnPct - Number(sample.executionCostPct);
      sample.returnPct = sample.netReturnPct;
    }
  }

  record(candidates, now = Date.now()) {
    const observedEpisodeKeys = new Set();
    const observedPullbackKeys = new Set();
    for (const candidate of candidates) {
      for (const rule of this.rules) {
        if (!shadowRuleMatches(candidate, rule)) continue;
        const key = `${rule.name}:${candidate.address}`;
        observedEpisodeKeys.add(key);
        if (finite(rule.pullbackMinPct)) {
          observedPullbackKeys.add(key);
          const price = Number(candidate.marketSafety.tokenPriceQuote);
          let setup = this.pullbackSetups.get(key);
          if (!setup || now - setup.startedAt > Number(rule.setupMaxAgeMs || FIVE_MINUTES)) {
            this.pullbackSetups.set(key, { startedAt: now, peakPrice: price });
            continue;
          }
          setup.peakPrice = Math.max(setup.peakPrice, price);
          const pullbackPct = ((setup.peakPrice - price) / setup.peakPrice) * 100;
          if (pullbackPct > Number(rule.pullbackMaxPct)) {
            this.pullbackSetups.delete(key);
            continue;
          }
          if (pullbackPct < Number(rule.pullbackMinPct)) continue;
        }
        const episode = this.episodes.get(key);
        if (episode) {
          episode.lastQualifiedAt = now;
          continue;
        }
        const episodeId = `${key}:${now}`;
        this.episodes.set(key, { episodeId, lastQualifiedAt: now });
        this.samples.push({
          rule: rule.name,
          ruleVersion: RULE_VERSION,
          episodeId,
          horizonMs: this.horizonMs,
          pool: candidate.address,
          quoteToken: candidate.marketSafety.quoteToken,
          entryPrice: Number(candidate.marketSafety.tokenPriceQuote),
          executionCostPct: Number(candidate.marketSafety.executionCostPct),
          openedAt: now,
        });
        if (finite(rule.pullbackMinPct)) this.pullbackSetups.delete(key);
      }
    }
    for (const [key, episode] of this.episodes) {
      if (!observedEpisodeKeys.has(key)
          && now - episode.lastQualifiedAt >= this.episodeGapMs) {
        this.episodes.delete(key);
      }
    }
    for (const key of this.pullbackSetups.keys()) {
      if (!observedPullbackKeys.has(key)) this.pullbackSetups.delete(key);
    }
  }

  observe(candidates, now = Date.now()) {
    this.resolve(candidates, now);
    this.record(candidates, now);
  }

  snapshot() {
    const currentSamples = this.samples.filter(
      (sample) => sample.ruleVersion === RULE_VERSION,
    );
    const byRule = {};
    for (const rule of this.rules) {
      const matching = currentSamples.filter((sample) => sample.rule === rule.name);
      const summary = summarizeSamples(matching);
      byRule[rule.name] = {
        openSamples: matching.filter((sample) => !sample.closedAt
          && !sample.censoredAt).length,
        ...summary,
        promotion: evaluateShadowPromotion(summary),
      };
    }
    return {
      mode: "SHADOW_ONLY",
      ruleVersion: RULE_VERSION,
      horizonMs: this.horizonMs,
      horizonsMs: this.horizonsMs,
      episodeGapMs: this.episodeGapMs,
      promotionPolicy: DEFAULT_PROMOTION_POLICY,
      currentSampleCount: currentSamples.length,
      legacySampleCount: this.samples.length - currentSamples.length,
      byRule,
      recentSamples: currentSamples.slice(-50),
    };
  }

  serialize() {
    return {
      horizonMs: this.horizonMs,
      horizonsMs: this.horizonsMs,
      episodeGapMs: this.episodeGapMs,
      samples: this.samples,
      episodes: Object.fromEntries(this.episodes),
      pullbackSetups: Object.fromEntries(this.pullbackSetups),
    };
  }

  restore(state) {
    if (!state || !Array.isArray(state.samples)) return;
    this.samples = state.samples.slice(-2000);
    this.episodes = new Map(Object.entries(state.episodes || {}));
    this.pullbackSetups = new Map(Object.entries(state.pullbackSetups || {}));
  }
}
