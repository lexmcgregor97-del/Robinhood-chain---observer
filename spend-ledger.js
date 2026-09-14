const dayKey = (now) => new Date(now).toISOString().slice(0, 10);

export class DailySpendLedger {
  constructor(state = {}) {
    this.day = state.day || null;
    this.spent = new Map(Object.entries(state.spent || {}).map(
      ([asset, amount]) => [asset, BigInt(String(amount))],
    ));
    this.intentIds = new Set(state.intentIds || []);
  }

  roll(now = Date.now()) {
    const current = dayKey(now);
    if (this.day !== current) {
      this.day = current;
      this.spent.clear();
      this.intentIds.clear();
    }
  }

  record({ intentId, asset, amount }, now = Date.now()) {
    this.roll(now);
    const id = String(intentId || "");
    const normalizedAsset = String(asset || "").toLowerCase();
    const normalizedAmount = BigInt(String(amount));
    if (!id) throw new Error("invalid-intent-id");
    if (!normalizedAsset || normalizedAmount <= 0n) throw new Error("invalid-spend");
    if (this.intentIds.has(id)) throw new Error("duplicate-intent");
    this.intentIds.add(id);
    this.spent.set(normalizedAsset, (this.spent.get(normalizedAsset) || 0n) + normalizedAmount);
    return this.snapshot(now);
  }

  snapshot(now = Date.now()) {
    this.roll(now);
    return {
      day: this.day,
      spent: Object.fromEntries([...this.spent].map(([asset, amount]) => [asset, amount.toString()])),
      intentIds: [...this.intentIds],
    };
  }
}
