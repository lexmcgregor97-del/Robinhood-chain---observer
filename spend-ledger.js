import { createExecutionMutationSerializer } from "./execution-mutation-queue.js";

const dayKey = (now) => new Date(now).toISOString().slice(0, 10);

export class DailySpendLedger {
  constructor(state = {}, { persist = async () => {},
    serialize = createExecutionMutationSerializer() } = {}) {
    if (typeof persist !== "function") throw new Error("invalid-spend-persist");
    if (typeof serialize !== "function") throw new Error("invalid-spend-serializer");
    this.persist = persist;
    this.serialize = serialize;
    this.day = state.day || null;
    this.spent = new Map(Object.entries(state.spent || {}).map(
      ([asset, amount]) => [asset, BigInt(String(amount))],
    ));
    this.intentIds = new Set(state.intentIds || []);
    this.mutationCount = Number(state.mutationCount || 0);
    if (!Number.isSafeInteger(this.mutationCount) || this.mutationCount < 0) {
      throw new Error("invalid-spend-state");
    }
  }

  current(now = Date.now()) {
    return this.day === dayKey(now)
      ? { day: this.day, spent: this.spent, intentIds: this.intentIds }
      : { day: dayKey(now), spent: new Map(), intentIds: new Set() };
  }

  record(input, now = Date.now()) {
    return this.serialize(() => this.applyRecord(input, now));
  }

  async applyRecord({ intentId, asset, amount }, now) {
    const current = this.current(now);
    const id = String(intentId || "");
    const normalizedAsset = String(asset || "").toLowerCase();
    const normalizedAmount = BigInt(String(amount));
    if (!id) throw new Error("invalid-intent-id");
    if (!normalizedAsset || normalizedAmount <= 0n) throw new Error("invalid-spend");
    if (current.intentIds.has(id)) throw new Error("duplicate-intent");
    const previous = { day: this.day, spent: this.spent,
      intentIds: this.intentIds, mutationCount: this.mutationCount };
    this.day = current.day;
    this.spent = new Map(current.spent);
    this.intentIds = new Set(current.intentIds);
    this.intentIds.add(id);
    this.spent.set(normalizedAsset, (this.spent.get(normalizedAsset) || 0n) + normalizedAmount);
    this.mutationCount += 1;
    try {
      await this.persist(this.snapshot(now), { type: "execution-spend-recorded",
        intentId: id, asset: normalizedAsset, amount: normalizedAmount.toString(),
        day: this.day });
    } catch (error) {
      Object.assign(this, previous);
      throw error;
    }
    return this.snapshot(now);
  }

  snapshot(now = Date.now()) {
    const current = this.current(now);
    return {
      day: current.day,
      mutationCount: this.mutationCount,
      spent: Object.fromEntries([...current.spent].map(
        ([asset, amount]) => [asset, amount.toString()])),
      intentIds: [...current.intentIds],
    };
  }
}
