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
    const quantity = filledQuantity === undefined
      ? (notional - fee) / price
      : finitePositive(filledQuantity, "quantity");
    if (quantityUnits !== null) {
      // Exact filled quantity in token base units; exits must use this, never a
      // Number -> BigInt round trip (see review finding C-1).
      if (typeof quantityUnits !== "string" || !/^[0-9]+$/.test(quantityUnits)
          || BigInt(quantityUnits) <= 0n) throw new Error("invalid-quantity-units");
    }
    const position = { pool, token, quantity, quantityUnits, entryPrice: price, markPrice: price,
      costBasis: notional + gasCost, entryNotional: notional, entryFee: fee,
      entryGasCost: gasCost, openedAt: timestamp, peakPrice: price,
      entryAudit: audit ? structuredClone(audit) : null };
    this.cash -= notional + gasCost;
    this.positions.set(pool, position);
    this.trades.push({ type: "open", pool, token, price, quantity, quantityUnits, notional,
      gasCost, fee, timestamp,
      audit: audit ? structuredClone(audit) : null });
    return { ...position };
  }

  mark(pool, price) {
    const position = this.positions.get(pool);
    if (!position) throw new Error("position-not-found");
    position.markPrice = finitePositive(price, "price");
    position.peakPrice = Math.max(position.peakPrice || position.entryPrice, position.markPrice);
    return this.positionSnapshot(position);
  }

  close({
    pool, price, proceeds: filledProceeds,
    fee = 0, gasCost = 0, timestamp = Date.now(), reason = "manual", audit = null,
    measurementFailure = false,
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
    const grossProceeds = filledProceeds === undefined
      ? position.quantity * price - fee
      : finiteNonNegative(filledProceeds, "proceeds");
    const proceeds = Math.max(0, grossProceeds - gasCost);
    const pnl = proceeds - position.costBasis;
    this.cash += proceeds;
    this.realizedPnl += pnl;
    this.positions.delete(pool);
    const trade = { type: "close", pool, token: position.token, price,
      quantity: position.quantity, grossProceeds, proceeds, gasCost, fee, pnl, reason, timestamp,
      measurementFailure: measurementFailure === true,
      audit: audit ? structuredClone(audit) : null };
    this.trades.push(trade);
    return { ...trade };
  }

  positionSnapshot(position) {
    const expectedExitGasCost = Number(position.entryGasCost || 0);
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
    }]));
    if (![this.cash, this.realizedPnl, ...[...this.positions.values()].flatMap((p) => [
      p.quantity, p.entryPrice, p.markPrice, p.costBasis, p.entryNotional, p.entryGasCost,
    ])].every(Number.isFinite)) throw new Error("invalid-paper-state");
    const accounted = this.cash + [...this.positions.values()]
      .reduce((sum, position) => sum + position.costBasis, 0);
    const expected = this.initialCash + this.realizedPnl;
    const tolerance = Math.max(1e-12, Math.abs(expected) * 1e-9);
    if (Math.abs(accounted - expected) > tolerance) throw new Error("paper-ledger-invariant-failed");
  }
}
