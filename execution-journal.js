const FINAL = new Set(["confirmed", "reverted", "rejected"]);
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

export class ExecutionJournal {
  constructor(state = {}, { persist = async () => {} } = {}) {
    if (typeof persist !== "function") throw new Error("invalid-journal-persist");
    this.persist = persist;
    this.records = new Map();
    for (const record of state.records || []) {
      if (!record?.intentId || this.records.has(record.intentId)) throw new Error("invalid-journal-state");
      this.records.set(record.intentId, { ...record });
    }
  }

  async transition(intentId, patch, now = Date.now()) {
    const id = String(intentId || "");
    if (!id) throw new Error("invalid-intent-id");
    const existing = this.records.get(id);
    const previous = existing || { intentId: id, createdAt: now };
    if (FINAL.has(previous.status)) throw new Error("execution-already-final");
    if (patch.transactionHash && !TX_HASH.test(patch.transactionHash)) throw new Error("invalid-transaction-hash");
    const next = { ...previous, ...patch, intentId: id, updatedAt: now };
    this.records.set(id, next);
    try {
      await this.persist(this.snapshot());
    } catch (error) {
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
    return { records: [...this.records.values()].map((record) => ({ ...record })) };
  }
}
