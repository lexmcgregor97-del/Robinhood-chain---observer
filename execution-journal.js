import { createExecutionMutationSerializer } from "./execution-mutation-queue.js";

const FINAL = new Set(["confirmed", "reverted", "rejected", "operator-rejected"]);
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

export class ExecutionJournal {
  constructor(state = {}, { persist = async () => {},
    serialize = createExecutionMutationSerializer() } = {}) {
    if (typeof persist !== "function") throw new Error("invalid-journal-persist");
    if (typeof serialize !== "function") throw new Error("invalid-journal-serializer");
    this.persist = persist;
    this.serialize = serialize;
    this.records = new Map();
    this.transitionCount = Number(state.transitionCount || 0);
    if (!Number.isSafeInteger(this.transitionCount) || this.transitionCount < 0) {
      throw new Error("invalid-journal-state");
    }
    for (const record of state.records || []) {
      if (!record?.intentId || this.records.has(record.intentId)) throw new Error("invalid-journal-state");
      this.records.set(record.intentId, { ...record });
    }
  }

  transition(intentId, patch, now = Date.now()) {
    return this.serialize(() => this.applyTransition(intentId, patch, now));
  }

  async applyTransition(intentId, patch, now) {
    const id = String(intentId || "");
    if (!id) throw new Error("invalid-intent-id");
    const existing = this.records.get(id);
    const previous = existing || { intentId: id, createdAt: now };
    if (FINAL.has(previous.status)) throw new Error("execution-already-final");
    if (patch.transactionHash && !TX_HASH.test(patch.transactionHash)) throw new Error("invalid-transaction-hash");
    const next = { ...previous, ...patch, intentId: id, updatedAt: now };
    const previousTransitionCount = this.transitionCount;
    this.records.set(id, next);
    this.transitionCount += 1;
    try {
      await this.persist(this.snapshot(), { type: "execution-transition",
        intentId: id, record: { ...next } });
    } catch (error) {
      this.transitionCount = previousTransitionCount;
      if (!existing) this.records.delete(id);
      else this.records.set(id, previous);
      throw error;
    }
    return Object.freeze({ ...next });
  }

  get(intentId) {
    const record = this.records.get(intentId);
    return record ? Object.freeze({ ...record }) : null;
  }

  pending() {
    return [...this.records.values()]
      .filter((record) => !FINAL.has(record.status))
      .map((record) => Object.freeze({ ...record }));
  }

  snapshot() {
    return { transitionCount: this.transitionCount,
      records: [...this.records.values()].map((record) => ({ ...record })) };
  }
}
