const finitePositive = (value) => Number.isFinite(Number(value)) && Number(value) > 0;
const lower = (value) => String(value || "").toLowerCase();

export const DISLOCATION_OBSERVER_VERSION = "2026-09-15-cross-venue-v1";

export const DEFAULT_DISLOCATION_POLICY = Object.freeze({
  quoteToken: null,
  minimumPoolAgeBlocks: 7_200,
  minimumLifetimeSwaps: 20,
  minimumGrossSpreadPct: 1,
  minimumEstimatedNetEdgePct: 0.25,
  horizonMs: 5 * 60_000,
  episodeGapMs: 5 * 60_000,
  maximumSamples: 2_000,
});

function eligible(pool, policy) {
  const safety = pool?.marketSafety || {};
  return pool?.version === "v2"
    && lower(safety.quoteToken) === lower(policy.quoteToken)
    && finitePositive(safety.tokenPriceQuote)
    && safety.liquidityKnown === true
    && safety.buyMathOk === true
    && safety.sellMathOk === true
    && Number(safety.poolAgeBlocks) >= policy.minimumPoolAgeBlocks
    && Number(pool.swapCount) >= policy.minimumLifetimeSwaps
    && finitePositive(safety.executionCostPct);
}

function pairKey(pool) {
  return `${lower(pool.marketSafety.baseToken)}:${lower(pool.marketSafety.quoteToken)}`;
}

export function findCrossVenueDislocations(pools, policy = DEFAULT_DISLOCATION_POLICY) {
  policy = { ...DEFAULT_DISLOCATION_POLICY, ...policy };
  const groups = new Map();
  for (const pool of pools.filter((candidate) => eligible(candidate, policy))) {
    const values = groups.get(pairKey(pool)) || [];
    values.push(pool);
    groups.set(pairKey(pool), values);
  }
  const opportunities = [];
  for (const [key, group] of groups) {
    for (let left = 0; left < group.length; left += 1) {
      for (let right = left + 1; right < group.length; right += 1) {
        const a = group[left];
        const b = group[right];
        if (a.dex === b.dex) continue;
        const buy = Number(a.marketSafety.tokenPriceQuote)
          <= Number(b.marketSafety.tokenPriceQuote) ? a : b;
        const sell = buy === a ? b : a;
        const buyPrice = Number(buy.marketSafety.tokenPriceQuote);
        const sellPrice = Number(sell.marketSafety.tokenPriceQuote);
        const grossSpreadPct = ((sellPrice / buyPrice) - 1) * 100;
        // Deliberately charge each venue's full round-trip estimate even though
        // a cross-venue trade uses one side at each venue. This is a passive,
        // conservative screen; execution work must later replace this estimate
        // with exact directional quotes and gas before any strategy is promoted.
        const estimatedCostPct = Number(buy.marketSafety.executionCostPct)
          + Number(sell.marketSafety.executionCostPct);
        const estimatedNetEdgePct = grossSpreadPct - estimatedCostPct;
        if (grossSpreadPct < policy.minimumGrossSpreadPct
            || estimatedNetEdgePct < policy.minimumEstimatedNetEdgePct) continue;
        opportunities.push({
          key,
          baseToken: lower(buy.marketSafety.baseToken),
          quoteToken: lower(buy.marketSafety.quoteToken),
          buyPool: lower(buy.address),
          buyVenue: buy.dex,
          sellPool: lower(sell.address),
          sellVenue: sell.dex,
          buyPrice,
          sellPrice,
          grossSpreadPct,
          estimatedCostPct,
          estimatedNetEdgePct,
        });
      }
    }
  }
  return opportunities.sort((a, b) => b.estimatedNetEdgePct - a.estimatedNetEdgePct);
}

export class PassiveDislocationObserver {
  constructor(policy = {}) {
    this.policy = Object.freeze({ ...DEFAULT_DISLOCATION_POLICY, ...policy });
    this.samples = [];
    this.episodes = new Map();
  }

  pendingPoolAddresses() {
    return [...new Set(this.samples.filter((sample) => !sample.resolvedAt)
      .flatMap((sample) => [sample.buyPool, sample.sellPool]))];
  }

  observe(pools, now = Date.now(), { block = null } = {}) {
    const opportunities = findCrossVenueDislocations(pools, this.policy);
    const current = new Map(opportunities.map((item) => [
      `${item.key}:${item.buyPool}:${item.sellPool}`, item,
    ]));
    for (const sample of this.samples) {
      if (sample.resolvedAt || now - sample.openedAt < this.policy.horizonMs) continue;
      const key = `${sample.key}:${sample.buyPool}:${sample.sellPool}`;
      const observed = current.get(key);
      sample.resolvedAt = now;
      sample.exitBlock = block;
      sample.exitEstimatedNetEdgePct = observed?.estimatedNetEdgePct ?? 0;
      sample.edgeContractionPct = sample.entryEstimatedNetEdgePct
        - sample.exitEstimatedNetEdgePct;
      sample.converged = sample.exitEstimatedNetEdgePct
        < this.policy.minimumEstimatedNetEdgePct;
    }
    for (const opportunity of opportunities) {
      const episodeKey = `${opportunity.key}:${opportunity.buyPool}:${opportunity.sellPool}`;
      const episode = this.episodes.get(episodeKey);
      if (episode && now - episode.lastObservedAt < this.policy.episodeGapMs) {
        episode.lastObservedAt = now;
        continue;
      }
      this.episodes.set(episodeKey, { lastObservedAt: now });
      this.samples.push({
        version: DISLOCATION_OBSERVER_VERSION,
        episodeId: `${episodeKey}:${now}`,
        ...opportunity,
        entryEstimatedNetEdgePct: opportunity.estimatedNetEdgePct,
        openedAt: now,
        entryBlock: block,
        resolvedAt: null,
      });
    }
    if (this.samples.length > this.policy.maximumSamples) {
      this.samples = this.samples.slice(-this.policy.maximumSamples);
    }
    for (const [key, episode] of this.episodes) {
      if (!current.has(key) && now - episode.lastObservedAt >= this.policy.episodeGapMs) {
        this.episodes.delete(key);
      }
    }
  }

  snapshot() {
    const samples = this.samples.filter((sample) => sample.version
      === DISLOCATION_OBSERVER_VERSION);
    const resolved = samples.filter((sample) => sample.resolvedAt);
    const converged = resolved.filter((sample) => sample.converged);
    return {
      mode: "PASSIVE_OBSERVATION_ONLY",
      version: DISLOCATION_OBSERVER_VERSION,
      policy: this.policy,
      openSamples: samples.length - resolved.length,
      resolvedSamples: resolved.length,
      uniqueBaseTokens: new Set(samples.map((sample) => sample.baseToken)).size,
      convergenceRatePct: resolved.length ? converged.length / resolved.length * 100 : 0,
      averageEntryEstimatedNetEdgePct: samples.length
        ? samples.reduce((sum, sample) => sum + sample.entryEstimatedNetEdgePct, 0)
          / samples.length : 0,
      averageEdgeContractionPct: resolved.length
        ? resolved.reduce((sum, sample) => sum + sample.edgeContractionPct, 0)
          / resolved.length : 0,
      recentSamples: samples.slice(-50),
    };
  }

  serialize() {
    return { policy: this.policy, samples: this.samples,
      episodes: Object.fromEntries(this.episodes) };
  }

  restore(state) {
    if (!state || !Array.isArray(state.samples)) return;
    this.samples = state.samples.slice(-this.policy.maximumSamples);
    this.episodes = new Map(Object.entries(state.episodes || {}));
  }
}
