const INPUT_BLOCKERS = new Set(["gas-estimate-required", "sell-probe-required"]);

// This counterfactual is for research accounting only; never use it to place orders.
export function opportunityQualification(candidate, portfolio, policy, now, planner) {
  if (!candidate.riskGate || !Array.isArray(candidate.riskGate.failures)
      || (candidate.riskGate.eligibleForPaperEntry !== true
        && candidate.riskGate.failures.length === 0)) return false;
  const failures = (candidate.riskGate?.failures || []).filter((f) => !INPUT_BLOCKERS.has(f));
  const researchCandidate = { ...candidate,
    riskGate: { ...candidate.riskGate, failures,
      eligibleForPaperEntry: failures.length === 0 },
  };
  return planner(researchCandidate, portfolio, policy, now).approved === true;
}

export class PaperOpportunities {
  constructor(state = {}) {
    if (state && (typeof state !== "object" || Array.isArray(state))) {
      throw new Error("invalid-opportunity-checkpoint");
    }
    this.state = structuredClone({ evaluations: 0, strategyQualified: 0,
      evidenceBlocked: 0, episodes: 0, active: {}, byCohort: {}, ...state });
  }
  record({ cohort, candidate, reasons, qualified, approved, now }) {
    const key = `${cohort}:${candidate.address}`;
    const s = this.state;
    const counts = s.byCohort[cohort] ||= { evaluations: 0, strategyQualified: 0,
      evidenceBlocked: 0, episodes: 0, reasonCombinations: {} };
    counts.evaluations += 1;
    const combination = JSON.stringify([...new Set(reasons)].sort());
    counts.reasonCombinations[combination] = (counts.reasonCombinations[combination] || 0) + 1;
    s.evaluations += 1;
    if (qualified) s.strategyQualified += 1;
    if (qualified) counts.strategyQualified += 1;
    const evidenceOnly = qualified && !approved && reasons.length > 0
      && reasons.every((r) => INPUT_BLOCKERS.has(r));
    if (evidenceOnly) s.evidenceBlocked += 1;
    if (evidenceOnly) counts.evidenceBlocked += 1;
    let episode = s.active[key];
    // An episode ends at the first disqualifying evaluation or a five-minute gap.
    // Counts are per cohort: do not add them as distinct market-wide setups.
    if (episode && now - episode.lastSeenAt > 5 * 60_000) {
      delete s.active[key]; episode = null;
    }
    const price = Number(candidate.marketSafety?.tokenPriceQuote);
    if (qualified && !episode) {
      s.episodes += 1;
      counts.episodes += 1;
      episode = { id: `${cohort}:${candidate.address}:${now}`, firstSeenAt: now,
        initialPrice: Number.isFinite(price) && price > 0 ? price : null };
      s.active[key] = episode;
    }
    const event = { type: "paper-opportunity-evaluation", cohort,
      pool: candidate.address, at: now, strategyQualified: qualified,
      approved, evidenceOnly, reasons: [...reasons], episodeId: episode?.id || null,
      signal: candidate.signal, price: Number.isFinite(price) ? price : null,
      observedMidPriceReturnPct: episode?.initialPrice && Number.isFinite(price) && price > 0
        ? (price / episode.initialPrice - 1) * 100 : null };
    if (episode) episode.lastSeenAt = now;
    if (!qualified) delete s.active[key];
    for (const [k, value] of Object.entries(s.active)) {
      if (now - value.lastSeenAt > 5 * 60_000) delete s.active[k];
    }
    return event;
  }
  snapshot() { return structuredClone(this.state); }
}
