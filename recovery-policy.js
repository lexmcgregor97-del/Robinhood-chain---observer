const positiveInteger = (value, name) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name}-invalid`);
  return parsed;
};

const nonNegativeInteger = (value, name) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name}-invalid`);
  return parsed;
};

export function planLosslessRecovery({ cursor, latest, maxBlocksPerPoll }) {
  const normalizedCursor = nonNegativeInteger(cursor, "recovery-cursor");
  const normalizedLatest = nonNegativeInteger(latest, "recovery-latest");
  const limit = positiveInteger(maxBlocksPerPoll, "recovery-limit");
  if (normalizedLatest <= normalizedCursor) {
    return Object.freeze({
      required: false,
      from: null,
      to: null,
      remainingBlocks: 0,
      skippedBlocks: 0,
    });
  }
  const to = Math.min(normalizedLatest, normalizedCursor + limit);
  return Object.freeze({
    required: true,
    from: normalizedCursor + 1,
    to,
    remainingBlocks: normalizedLatest - to,
    skippedBlocks: 0,
  });
}

export function recoveryPaperCycleMode({ synchronized, openPositions }) {
  const count = nonNegativeInteger(openPositions, "recovery-open-positions");
  if (synchronized === true) return "full";
  return count > 0 ? "exits-only" : "paused";
}

export function paperOpenPositionCount(states = []) {
  if (!Array.isArray(states) || states.some((state) => (
    !state || !Array.isArray(state.openPositions)
  ))) throw new Error("recovery-paper-state-invalid");
  return states.reduce((total, state) => total + state.openPositions.length, 0);
}

export function paperCycleDuringRecovery(synchronized) {
  if (typeof synchronized !== "boolean") {
    throw new Error("recovery-synchronization-state-invalid");
  }
  return !synchronized;
}
