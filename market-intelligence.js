const finite = (value) => typeof value === "number" && Number.isFinite(value);
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const saturate = (value, scale) => {
  const bounded = Math.max(0, value);
  return bounded / (bounded + scale);
};

const median = (values) => {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export const MARKET_INTELLIGENCE_VERSION = "2026-09-18-dormant-market-intelligence-v1";
export const RELATIVE_STRENGTH_SCALES = Object.freeze({
  signalScore: 50,
  acceleration: 2,
  volumeMultiple: 2,
});

export function classifyMarketRegime(candidates, {
  minimumCoverage = 4,
  expansionBreadthPct = 40,
  contractionBreadthPct = 15,
  contractionMedianAcceleration = 0.6,
} = {}) {
  if (!Array.isArray(candidates)) throw new Error("invalid-market-candidates");
  const measured = candidates.filter((candidate) => (
    finite(candidate?.signal?.acceleration)
    && finite(candidate?.signal?.swapsCurrentWindow)
  ));
  if (measured.length < minimumCoverage) {
    return {
      regime: "unavailable",
      coverage: measured.length,
      coverageConfidence: clamp(measured.length / Math.max(minimumCoverage, 10), 0, 1),
      separationMargin: null,
    };
  }
  const active = measured.filter((candidate) => candidate.signal.swapsCurrentWindow > 0);
  const expanding = measured.filter((candidate) => (
    candidate.signal.swapsCurrentWindow > 0
    && (["breakout-watch", "escape-velocity"].includes(candidate.signal.state)
      || candidate.signal.acceleration >= 2)
  ));
  const activeBreadthPct = active.length / measured.length * 100;
  const expansionBreadth = expanding.length / measured.length * 100;
  const medianAcceleration = median(measured.map((candidate) => candidate.signal.acceleration));
  let regime = "rotational-chop";
  // Explicit expansion states are direct evidence and win ambiguous ties.
  if (expansionBreadth >= expansionBreadthPct) regime = "broad-expansion";
  else if (expansionBreadth >= expansionBreadthPct / 2) regime = "concentrated-expansion";
  else if (activeBreadthPct <= contractionBreadthPct
      && medianAcceleration <= contractionMedianAcceleration) regime = "contraction";
  const broadBoundary = expansionBreadthPct;
  const concentratedBoundary = expansionBreadthPct / 2;
  const distanceToContraction = Math.max(
    Math.max(0, activeBreadthPct - contractionBreadthPct)
      / Math.max(1, contractionBreadthPct),
    Math.max(0, medianAcceleration - contractionMedianAcceleration)
      / Math.max(0.01, contractionMedianAcceleration),
  );
  let rawSeparation;
  if (regime === "broad-expansion") {
    rawSeparation = (expansionBreadth - broadBoundary) / Math.max(1, broadBoundary);
  } else if (regime === "concentrated-expansion") {
    rawSeparation = Math.min(
      (expansionBreadth - concentratedBoundary) / Math.max(1, concentratedBoundary),
      (broadBoundary - expansionBreadth) / Math.max(1, broadBoundary),
    );
  } else if (regime === "contraction") {
    rawSeparation = Math.min(
      (contractionBreadthPct - activeBreadthPct) / Math.max(1, contractionBreadthPct),
      (contractionMedianAcceleration - medianAcceleration)
        / Math.max(0.01, contractionMedianAcceleration),
    );
  } else {
    rawSeparation = Math.min(
      (concentratedBoundary - expansionBreadth) / Math.max(1, concentratedBoundary),
      distanceToContraction,
    );
  }
  const separationMargin = Math.round(clamp(rawSeparation, 0, 1) * 1_000) / 1_000;
  return {
    regime,
    coverage: measured.length,
    activeBreadthPct,
    expansionBreadthPct: expansionBreadth,
    medianAcceleration,
    coverageConfidence: clamp(measured.length / Math.max(minimumCoverage, 10), 0, 1),
    separationMargin,
  };
}

export function rankRelativeStrength(candidates, {
  executionPenaltyWeight = 2,
  maximumExecutionCostPct = 15,
} = {}) {
  if (!Array.isArray(candidates)) throw new Error("invalid-market-candidates");
  const eligible = candidates.filter((candidate) => (
    candidate?.address
    && finite(candidate?.signal?.score)
    && finite(candidate?.signal?.acceleration)
    && finite(candidate?.marketSafety?.executionCostPct)
  ));
  return eligible.map((candidate) => {
    const flow = candidate.signal.adaptiveFlow || {};
    const buyShare = finite(flow.buyShare) ? flow.buyShare : 0.5;
    const volumeMultiple = finite(flow.volumeMultiple) ? flow.volumeMultiple : 1;
    const executionCostPct = candidate.marketSafety.executionCostPct;
    // Fixed saturating transforms preserve score comparability across calls.
    const rawScore = saturate(candidate.signal.score, RELATIVE_STRENGTH_SCALES.signalScore) * 35
      + saturate(candidate.signal.acceleration,
        RELATIVE_STRENGTH_SCALES.acceleration) * 25
      + saturate(volumeMultiple, RELATIVE_STRENGTH_SCALES.volumeMultiple) * 20
      + buyShare * 20
      - executionCostPct * executionPenaltyWeight;
    return {
      address: String(candidate.address).toLowerCase(),
      relativeStrengthScore: Math.round(clamp(rawScore, 0, 100) * 100) / 100,
      executable: executionCostPct <= maximumExecutionCostPct
        && candidate.marketSafety.sellMathOk === true,
      components: {
        signalScore: candidate.signal.score,
        acceleration: candidate.signal.acceleration,
        volumeMultiple,
        buyShare,
        executionCostPct,
      },
    };
  }).sort((a, b) => b.relativeStrengthScore - a.relativeStrengthScore)
    .map((item, index) => ({ ...item, rank: index + 1 }));
}

export function planCapitalReplacement({
  incumbent,
  challenger,
  minimumScoreAdvantage = 20,
  estimatedRotationCostPct = 0,
} = {}) {
  const incumbentScore = Number(incumbent?.relativeStrengthScore);
  const challengerScore = Number(challenger?.relativeStrengthScore);
  if (![incumbentScore, challengerScore, estimatedRotationCostPct].every(Number.isFinite)
      || estimatedRotationCostPct < 0) {
    return { replace: false, reason: "replacement-evidence-unavailable" };
  }
  if (challenger?.executable !== true) {
    return { replace: false, reason: "challenger-not-executable" };
  }
  const knownStates = ["strengthening", "healthy", "weakening", "invalidated", "emergency"];
  if (!knownStates.includes(incumbent?.signalState)) {
    return { replace: false, reason: "replacement-evidence-unavailable" };
  }
  if (!["weakening", "invalidated"].includes(incumbent.signalState)) {
    return { replace: false, reason: "incumbent-signal-protected" };
  }
  const netAdvantage = challengerScore - incumbentScore - estimatedRotationCostPct;
  return netAdvantage >= minimumScoreAdvantage
    ? { replace: true, reason: "material-relative-strength-advantage", netAdvantage }
    : { replace: false, reason: "advantage-insufficient", netAdvantage };
}

export const MARKET_INTELLIGENCE_BOUNDARY = Object.freeze({
  runtimeEnabled: false,
  entryEligible: false,
  replacementEnabled: false,
  liveExecutionSupported: false,
});
