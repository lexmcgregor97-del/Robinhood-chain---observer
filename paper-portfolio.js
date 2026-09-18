import { updateStopCounterfactuals } from "./paper-lifecycle-candidate.js";

const finitePositive = (value, name) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be positive`);
  return parsed;
};

const finiteNonNegative = (value, name) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be non-negative`);
  return parsed;
};

const MAX_LIFECYCLE_PRICE_SAMPLES = 100;

const partialRatio = (partUnits, totalUnits) => {
  const ratio = Number(partUnits) / Number(totalUnits);
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) {
    throw new Error("invalid-partial-quantity-units");
  }
  return ratio;
};

export function floorPartialQuantityUnits(quantityUnits, closeFraction) {
  if (typeof quantityUnits !== "string" || !/^[0-9]+$/.test(quantityUnits)) {
    throw new Error("invalid-partial-quantity-units");
  }
  if (typeof closeFraction !== "number" || !Number.isFinite(closeFraction)
      || closeFraction <= 0 || closeFraction >= 1) throw new Error("invalid-close-fraction");
  const heldUnits = BigInt(quantityUnits);
  const scale = 1_000_000_000_000_000n;
  const scaledFraction = BigInt(Math.floor(closeFraction * Number(scale)));
  const soldUnits = (heldUnits * scaledFraction) / scale;
  if (soldUnits <= 0n || soldUnits >= heldUnits) throw new Error("invalid-partial-quantity-units");
  return String(soldUnits);
}

export class PaperPortfolio {
  constructor({ initialCash = 1_000, maxPositions = 3, state } = {}) {
    this.initialCash = finitePositive(initialCash, "initialCash");
    this.maxPositions = Math.max(1, Number.parseInt(maxPositions, 10) || 1);
    this.cash = this.initialCash;
    this.realizedPnl = 0;
    this.positions = new Map();
    this.trades = [];
    if (state) this.restore(state);
  }

  open({
    pool, token, price, quantity: filledQuantity, quantityUnits = null,
    notional, fee = 0, gasCost = 0, timestamp = Date.now(), audit = null,
    entryAdverseBoundaryPct = null,
  }) {
    if (this.positions.has(pool)) throw new Error("position-already-open");
    if (this.positions.size >= this.maxPositions) throw new Error("position-limit-reached");
    price = finitePositive(price, "price");
    notional = finitePositive(notional, "notional");
    fee = Number(fee);
    gasCost = Number(gasCost);
    if (!Number.isFinite(fee) || fee < 0 || fee >= notional) throw new Error("invalid-fee");
    if (!Number.isFinite(gasCost) || gasCost < 0) throw new Error("invalid-gas-cost");
    if (notional + gasCost > this.cash) throw new Error("insufficient-paper-cash");
    if (entryAdverseBoundaryPct !== null) {
      entryAdverseBoundaryPct = finitePositive(
        entryAdverseBoundaryPct,
        "entryAdverseBoundaryPct",
      );
    }
    const quantity = filledQuantity === undefined
      ? (notional - fee) / price
      : finitePositive(filledQuantity, "quantity");
    if (quantityUnits !== null) {
      // Exact filled quantity in token base units; exits must use this, never a
      // Number -> BigInt round trip (see review finding C-1).
      if (typeof quantityUnits !== "string" || !/^[0-9]+$/.test(quantityUnits)
          || BigInt(quantityUnits) <= 0n) throw new Error("invalid-quantity-units");
    }
    const auditRecord = audit ? structuredClone(audit) : null;
    const positionAudit = auditRecord ? structuredClone(auditRecord) : null;
    const position = { pool, token, quantity, quantityUnits, entryPrice: price, markPrice: price,
      costBasis: notional + gasCost, entryNotional: notional, entryFee: fee,
      entryGasCost: gasCost, openedAt: timestamp, peakPrice: price,
      entryAudit: positionAudit,
      ...(entryAdverseBoundaryPct !== null ? { entryAdverseBoundaryPct } : {}) };
    const trade = { type: "open", pool, token, price, quantity, quantityUnits, notional,
      gasCost, fee, timestamp, audit: auditRecord,
      ...(entryAdverseBoundaryPct !== null ? { entryAdverseBoundaryPct } : {}) };
    this.cash -= notional + gasCost;
    this.positions.set(pool, position);
    this.trades.push(trade);
    return { ...position };
  }

  mark(pool, price) {
    const position = this.positions.get(pool);
    if (!position) throw new Error("position-not-found");
    position.markPrice = finitePositive(price, "price");
    position.peakPrice = Math.max(position.peakPrice || position.entryPrice, position.markPrice);
    return this.positionSnapshot(position);
  }

  recordLifecycleMark(pool, {
    returnPct, observedPrice, maxSamples = 12, timestamp = Date.now(),
  } = {}) {
    const position = this.positions.get(pool);
    if (!position) throw new Error("position-not-found");
    returnPct = Number(returnPct);
    observedPrice = Number(observedPrice ?? position.markPrice);
    maxSamples = Number(maxSamples);
    timestamp = Number(timestamp);
    if (!Number.isFinite(returnPct) || !Number.isFinite(observedPrice)
        || observedPrice <= 0 || !Number.isInteger(maxSamples)
        || maxSamples < 2 || maxSamples > MAX_LIFECYCLE_PRICE_SAMPLES
        || !Number.isFinite(timestamp) || timestamp < 0
        || (position.lastLifecycleMarkAt !== undefined
          && timestamp <= position.lastLifecycleMarkAt)) {
      throw new Error("invalid-lifecycle-mark");
    }
    position.maxFavorableExcursionPct = position.maxFavorableExcursionPct == null
      ? returnPct : Math.max(position.maxFavorableExcursionPct, returnPct);
    position.maxAdverseExcursionPct = position.maxAdverseExcursionPct == null
      ? returnPct : Math.min(position.maxAdverseExcursionPct, returnPct);
    position.observedPrices = [...(position.observedPrices || []), observedPrice].slice(-maxSamples);
    if (position.lastLifecycleMarkAt !== undefined) {
      position.observedMarkIntervalMs = timestamp - position.lastLifecycleMarkAt;
    }
    position.lastLifecycleMarkAt = timestamp;
    position.stopCounterfactuals = updateStopCounterfactuals(
      position.stopCounterfactuals,
      returnPct,
    );
    return this.positionSnapshot(position);
  }

  partialClose({
    pool, quantityUnits, price, proceeds: filledProceeds,
    fee = 0, gasCost = 0, timestamp = Date.now(), reason = "partial", audit = null,
  }) {
    const position = this.positions.get(pool);
    if (!position) throw new Error("position-not-found");
    if (position.partialProfitTaken === true) throw new Error("partial-already-taken");
    if (typeof position.quantityUnits !== "string") throw new Error("partial-exact-units-required");
    if (typeof quantityUnits !== "string" || !/^[0-9]+$/.test(quantityUnits)) {
      throw new Error("invalid-partial-quantity-units");
    }
    const heldUnits = BigInt(position.quantityUnits);
    const soldUnits = BigInt(quantityUnits);
    if (soldUnits <= 0n || soldUnits >= heldUnits) throw new Error("invalid-partial-quantity-units");
    const ratio = partialRatio(soldUnits, heldUnits);
    price = filledProceeds === undefined
      ? finitePositive(price, "price") : finiteNonNegative(price, "price");
    fee = Number(fee);
    gasCost = Number(gasCost);
    if (!Number.isFinite(fee) || fee < 0) throw new Error("invalid-fee");
    if (!Number.isFinite(gasCost) || gasCost < 0) throw new Error("invalid-gas-cost");
    const quantity = position.quantity * ratio;
    const grossProceeds = filledProceeds === undefined
      ? quantity * price - fee : finiteNonNegative(filledProceeds, "proceeds");
    const proceeds = Math.max(0, grossProceeds - gasCost);
    const allocatedCostBasis = position.costBasis * ratio;
    const pnl = proceeds - allocatedCostBasis;
    const remainingRatio = 1 - ratio;
    const remainingQuantity = position.quantity - quantity;
    const remainingQuantityUnits = String(heldUnits - soldUnits);
    const expectedExitGasCost = Number(position.expectedExitGasCost
      ?? position.entryGasCost ?? 0);
    const auditRecord = audit ? structuredClone(audit) : null;
    const trade = { type: "partial-close", pool, token: position.token, price,
      quantity, quantityUnits, remainingQuantity, remainingQuantityUnits,
      grossProceeds, proceeds, allocatedCostBasis, gasCost, fee, pnl, reason, timestamp,
      maxFavorableExcursionPct: position.maxFavorableExcursionPct ?? null,
      maxAdverseExcursionPct: position.maxAdverseExcursionPct ?? null,
      audit: auditRecord };
    position.quantity -= quantity;
    position.quantityUnits = remainingQuantityUnits;
    position.costBasis -= allocatedCostBasis;
    position.entryNotional *= remainingRatio;
    position.entryFee *= remainingRatio;
    position.entryGasCost *= remainingRatio;
    position.expectedExitGasCost = expectedExitGasCost;
    position.partialProfitTaken = true;
    this.cash += proceeds;
    this.realizedPnl += pnl;
    this.trades.push(trade);
    return { ...trade };
  }

  close({
    pool, price, proceeds: filledProceeds,
    fee = 0, gasCost = 0, timestamp = Date.now(), reason = "manual", audit = null,
    measurementFailure = false,
    appliedBoundaryPct = null,
  }) {
    const position = this.positions.get(pool);
    if (!position) throw new Error("position-not-found");
    price = filledProceeds === undefined
      ? finitePositive(price, "price")
      : finiteNonNegative(price, "price");
    fee = Number(fee);
    gasCost = Number(gasCost);
    if (!Number.isFinite(fee) || fee < 0) throw new Error("invalid-fee");
    if (!Number.isFinite(gasCost) || gasCost < 0) throw new Error("invalid-gas-cost");
    if (appliedBoundaryPct !== null) {
      appliedBoundaryPct = finitePositive(appliedBoundaryPct, "appliedBoundaryPct");
      if (position.entryAdverseBoundaryPct !== undefined
          && appliedBoundaryPct > position.entryAdverseBoundaryPct) {
        throw new Error("applied-boundary-widens-entry-risk");
      }
    }
    const grossProceeds = filledProceeds === undefined
      ? position.quantity * price - fee
      : finiteNonNegative(filledProceeds, "proceeds");
    const proceeds = Math.max(0, grossProceeds - gasCost);
    const pnl = proceeds - position.costBasis;
    const auditRecord = audit ? structuredClone(audit) : null;
    const trade = { type: "close", pool, token: position.token, price,
      quantity: position.quantity, grossProceeds, proceeds, gasCost, fee, pnl, reason, timestamp,
      measurementFailure: measurementFailure === true,
      partialProfitTaken: position.partialProfitTaken === true,
      maxFavorableExcursionPct: position.maxFavorableExcursionPct ?? null,
      maxAdverseExcursionPct: position.maxAdverseExcursionPct ?? null,
      entryAdverseBoundaryPct: position.entryAdverseBoundaryPct ?? null,
      appliedBoundaryPct,
      audit: auditRecord };
    this.cash += proceeds;
    this.realizedPnl += pnl;
    this.positions.delete(pool);
    this.trades.push(trade);
    return { ...trade };
  }

  positionSnapshot(position) {
    const expectedExitGasCost = Number(position.expectedExitGasCost
      ?? position.entryGasCost ?? 0);
    const marketValue = Math.max(0,
      position.quantity * position.markPrice - expectedExitGasCost);
    const returnPct = ((marketValue / position.costBasis) - 1) * 100;
    const peakMarketValue = Math.max(0,
      position.quantity * (position.peakPrice || position.markPrice) - expectedExitGasCost);
    const peakReturnPct = ((peakMarketValue / position.costBasis) - 1) * 100;
    return { ...position, marketValue, expectedExitGasCost,
      unrealizedPnl: marketValue - position.costBasis,
      returnPct, peakReturnPct };
  }

  snapshot() {
    const positions = [...this.positions.values()].map((position) => this.positionSnapshot(position));
    const marketValue = positions.reduce((sum, position) => sum + position.marketValue, 0);
    return { mode: "PAPER_ONLY", initialCash: this.initialCash, cash: this.cash,
      marketValue, equity: this.cash + marketValue, realizedPnl: this.realizedPnl,
      unrealizedPnl: positions.reduce((sum, position) => sum + position.unrealizedPnl, 0),
      openPositions: positions, tradeCount: this.trades.length };
  }

  serialize() {
    return { ...this.snapshot(), maxPositions: this.maxPositions, trades: this.trades };
  }

  restore(state) {
    if (state.mode !== "PAPER_ONLY" || !Array.isArray(state.openPositions) || !Array.isArray(state.trades)) throw new Error("invalid-paper-state");
    const malformedLifecycleState = state.openPositions.some((position) => (
      (position.partialProfitTaken !== undefined
        && typeof position.partialProfitTaken !== "boolean")
      || (position.maxFavorableExcursionPct !== undefined
        && (typeof position.maxFavorableExcursionPct !== "number"
          || !Number.isFinite(position.maxFavorableExcursionPct)))
      || (position.maxAdverseExcursionPct !== undefined
        && (typeof position.maxAdverseExcursionPct !== "number"
          || !Number.isFinite(position.maxAdverseExcursionPct)))
      || (position.expectedExitGasCost !== undefined
        && (typeof position.expectedExitGasCost !== "number"
          || !Number.isFinite(position.expectedExitGasCost)
          || position.expectedExitGasCost < 0))
      || (position.entryAdverseBoundaryPct !== undefined
        && (typeof position.entryAdverseBoundaryPct !== "number"
          || !Number.isFinite(position.entryAdverseBoundaryPct)
          || position.entryAdverseBoundaryPct <= 0))
      || (position.lastLifecycleMarkAt !== undefined
        && (typeof position.lastLifecycleMarkAt !== "number"
          || !Number.isFinite(position.lastLifecycleMarkAt)
          || position.lastLifecycleMarkAt < 0))
      || (position.observedMarkIntervalMs !== undefined
        && (typeof position.observedMarkIntervalMs !== "number"
          || !Number.isFinite(position.observedMarkIntervalMs)
          || position.observedMarkIntervalMs <= 0))
      || (position.observedPrices !== undefined
        && (!Array.isArray(position.observedPrices)
          || position.observedPrices.length > MAX_LIFECYCLE_PRICE_SAMPLES
          || position.observedPrices.some((price) => typeof price !== "number"
            || !Number.isFinite(price) || price <= 0)))
      || (position.stopCounterfactuals !== undefined
        && (!position.stopCounterfactuals || typeof position.stopCounterfactuals !== "object"
          || Object.entries(position.stopCounterfactuals).some(([threshold, item]) =>
            !["8", "15", "20", "30"].includes(threshold)
            || typeof item?.breached !== "boolean"
            || typeof item?.recoveredToBreakEven !== "boolean")))
    ));
    if (malformedLifecycleState) throw new Error("invalid-paper-state");
    this.cash = Number(state.cash);
    this.realizedPnl = Number(state.realizedPnl);
    this.trades = structuredClone(state.trades);
    this.positions = new Map(state.openPositions.map((position) => [position.pool, {
      pool: position.pool, token: position.token, quantity: Number(position.quantity),
      quantityUnits: typeof position.quantityUnits === "string" && /^[0-9]+$/.test(position.quantityUnits)
        ? position.quantityUnits : null,
      entryPrice: Number(position.entryPrice), markPrice: Number(position.markPrice),
      costBasis: Number(position.costBasis), entryNotional: Number(position.entryNotional
        ?? (Number(position.costBasis) - Number(position.entryGasCost || 0))),
      entryFee: Number(position.entryFee), entryGasCost: Number(position.entryGasCost || 0),
      openedAt: position.openedAt,
      peakPrice: Number(position.peakPrice || position.markPrice),
      entryAudit: position.entryAudit ? structuredClone(position.entryAudit) : null,
      ...(position.partialProfitTaken !== undefined
        ? { partialProfitTaken: position.partialProfitTaken === true } : {}),
      ...(position.maxFavorableExcursionPct !== undefined
        ? { maxFavorableExcursionPct: position.maxFavorableExcursionPct } : {}),
      ...(position.maxAdverseExcursionPct !== undefined
        ? { maxAdverseExcursionPct: position.maxAdverseExcursionPct } : {}),
      ...(position.observedPrices !== undefined
        ? { observedPrices: [...position.observedPrices] } : {}),
      ...(position.stopCounterfactuals !== undefined
        ? { stopCounterfactuals: structuredClone(position.stopCounterfactuals) } : {}),
      ...(position.expectedExitGasCost !== undefined
        ? { expectedExitGasCost: position.expectedExitGasCost } : {}),
      ...(position.entryAdverseBoundaryPct !== undefined
        ? { entryAdverseBoundaryPct: position.entryAdverseBoundaryPct } : {}),
      ...(position.lastLifecycleMarkAt !== undefined
        ? { lastLifecycleMarkAt: position.lastLifecycleMarkAt } : {}),
      ...(position.observedMarkIntervalMs !== undefined
        ? { observedMarkIntervalMs: position.observedMarkIntervalMs } : {}),
    }]));
    if (![this.cash, this.realizedPnl, ...[...this.positions.values()].flatMap((p) => [
      p.quantity, p.entryPrice, p.markPrice, p.costBasis, p.entryNotional, p.entryGasCost,
      ...(p.expectedExitGasCost !== undefined ? [p.expectedExitGasCost] : []),
      ...(p.entryAdverseBoundaryPct !== undefined ? [p.entryAdverseBoundaryPct] : []),
      ...(p.lastLifecycleMarkAt !== undefined ? [p.lastLifecycleMarkAt] : []),
      ...(p.observedMarkIntervalMs !== undefined ? [p.observedMarkIntervalMs] : []),
    ])].every(Number.isFinite)) throw new Error("invalid-paper-state");
    if ([...this.positions.values()].some((position) =>
      (position.maxFavorableExcursionPct != null
        && !Number.isFinite(Number(position.maxFavorableExcursionPct)))
      || (position.maxAdverseExcursionPct != null
        && !Number.isFinite(Number(position.maxAdverseExcursionPct)))
      || (position.observedPrices || []).some((price) => !Number.isFinite(price) || price <= 0)
      || (position.observedPrices || []).length > MAX_LIFECYCLE_PRICE_SAMPLES)) {
      throw new Error("invalid-paper-state");
    }
    const accounted = this.cash + [...this.positions.values()]
      .reduce((sum, position) => sum + position.costBasis, 0);
    const expected = this.initialCash + this.realizedPnl;
    const tolerance = Math.max(1e-12, Math.abs(expected) * 1e-9);
    if (Math.abs(accounted - expected) > tolerance) throw new Error("paper-ledger-invariant-failed");
  }
}
