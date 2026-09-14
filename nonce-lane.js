const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const laneKey = (chainId, walletAddress) => `${chainId}:${walletAddress.toLowerCase()}`;

export class NonceLane {
  constructor(state = {}, { persist = async () => {} } = {}) {
    if (typeof persist !== "function") throw new Error("invalid-nonce-persist");
    this.persist = persist;
    this.lanes = new Map();
    this.queues = new Map();
    for (const lane of state.lanes || []) {
      if (!lane?.key || !Number.isSafeInteger(lane.nextNonce) || lane.nextNonce < 0) {
        throw new Error("invalid-nonce-state");
      }
      this.lanes.set(lane.key, { ...lane, pending: lane.pending ? { ...lane.pending } : null });
    }
  }

  async reserve({ chainId, walletAddress, intentId }, getPendingNonce) {
    if (!Number.isSafeInteger(chainId) || chainId <= 0 || !ADDRESS.test(walletAddress || "")) {
      throw new Error("invalid-nonce-lane");
    }
    if (!intentId || typeof getPendingNonce !== "function") throw new Error("invalid-nonce-reservation");
    const key = laneKey(chainId, walletAddress);
    return this.serialized(key, async () => {
      const existing = this.lanes.get(key);
      if (existing?.pending) throw new Error("nonce-lane-blocked");
      const networkNonce = Number(await getPendingNonce());
      if (!Number.isSafeInteger(networkNonce) || networkNonce < 0) throw new Error("invalid-provider-nonce");
      const nonce = Math.max(networkNonce, existing?.nextNonce || 0);
      const next = { key, chainId, walletAddress: walletAddress.toLowerCase(), nextNonce: nonce + 1,
        pending: { intentId, nonce } };
      this.lanes.set(key, next);
      try {
        await this.persist(this.snapshot());
      } catch (error) {
        if (existing) this.lanes.set(key, existing); else this.lanes.delete(key);
        throw error;
      }
      return nonce;
    });
  }

  async finalize(intentId) {
    const match = [...this.lanes.values()].find((lane) => lane.pending?.intentId === intentId);
    if (!match) return false;
    return this.serialized(match.key, async () => {
      const current = this.lanes.get(match.key);
      if (current?.pending?.intentId !== intentId) return false;
      const previous = { ...current, pending: { ...current.pending } };
      this.lanes.set(match.key, { ...current, pending: null });
      try {
        await this.persist(this.snapshot());
      } catch (error) {
        this.lanes.set(match.key, previous);
        throw error;
      }
      return true;
    });
  }

  serialized(key, operation) {
    const previous = this.queues.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.queues.set(key, current);
    return current.finally(() => {
      if (this.queues.get(key) === current) this.queues.delete(key);
    });
  }

  snapshot() {
    return { lanes: [...this.lanes.values()].map((lane) => ({
      ...lane, pending: lane.pending ? { ...lane.pending } : null,
    })) };
  }
}
