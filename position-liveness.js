export class PositionLiveness {
  constructor({
    zeroLiquidityCycles = 3,
    unavailableCycles = 20,
    state = {},
  } = {}) {
    this.zeroLiquidityCycles = zeroLiquidityCycles;
    this.unavailableCycles = unavailableCycles;
    this.state = new Map(Object.entries(state));
  }

  observe(key, status) {
    if (status === "healthy") {
      this.state.delete(key);
      return null;
    }
    if (!["zero-liquidity", "unavailable"].includes(status)) {
      throw new Error("invalid-position-status");
    }
    const previous = this.state.get(key);
    const count = previous?.status === status ? Number(previous.count) + 1 : 1;
    this.state.set(key, { status, count });
    if (status === "zero-liquidity" && count >= this.zeroLiquidityCycles) {
      this.state.delete(key);
      return "liquidity-zero";
    }
    if (status === "unavailable" && count >= this.unavailableCycles) {
      this.state.delete(key);
      return "price-unavailable-timeout";
    }
    return null;
  }

  serialize() {
    return Object.fromEntries(this.state);
  }
}
