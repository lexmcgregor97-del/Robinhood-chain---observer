const dayKey = (now) => new Date(now).toISOString().slice(0, 10);

export class DailySpendLedger {
  constructor(state = {}) {
    this.day = state.day || null;
    this.spentWei = BigInt(String(state.spentWei || "0"));
    this.intentIds = new Set(state.intentIds || []);
  }

  roll(now = Date.now()) {
    const current = dayKey(now);
    if (this.day !== current) {
      this.day = current;
      this.spentWei = 0n;
      this.intentIds.clear();
    }
  }

  record({ intentId, amountWei }, now = Date.now()) {
    this.roll(now);
    const id = String(intentId || "");
    const amount = BigInt(String(amountWei));
    if (!id) throw new Error("invalid-intent-id");
    if (amount < 0n) throw new Error("invalid-spend");
    if (this.intentIds.has(id)) throw new Error("duplicate-intent");
    this.intentIds.add(id);
    this.spentWei += amount;
    return this.snapshot(now);
  }

  snapshot(now = Date.now()) {
    this.roll(now);
    return {
      day: this.day,
      spentWei: this.spentWei.toString(),
      intentIds: [...this.intentIds],
    };
  }
}
