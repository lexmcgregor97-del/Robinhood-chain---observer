import { createExecutionMutationSerializer } from "./execution-mutation-queue.js";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const laneKey = (chainId, walletAddress) => `${chainId}:${walletAddress.toLowerCase()}`;

export class NonceLane {
  constructor(state = {}, { persist = async () => {},
    serialize = createExecutionMutationSerializer() } = {}) {
    if (typeof persist !== "function") throw new Error("invalid-nonce-persist");
    if (typeof serialize !== "function") throw new Error("invalid-nonce-serializer");
    this.persist = persist;
    this.serialize = serialize;
    this.lanes = new Map();
    this.mutationCount = Number(state.mutationCount || 0);
    if (!Number.isSafeInteger(this.mutationCount) || this.mutationCount < 0) {
      throw new Error("invalid-nonce-state");
    }
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
    return this.serialize(async () => {
      const existing = this.lanes.get(key);
      if (existing?.pending) throw new Error("nonce-lane-blocked");
      const networkNonce = Number(await getPendingNonce());
      if (!Number.isSafeInteger(networkNonce) || networkNonce < 0) throw new Error("invalid-provider-nonce");
      const nonce = Math.max(networkNonce, existing?.nextNonce || 0);
      const next = { key, chainId, walletAddress: walletAddress.toLowerCase(), nextNonce: nonce + 1,
        pending: { intentId, nonce } };
      const previousMutationCount = this.mutationCount;
      this.lanes.set(key, next);
      this.mutationCount += 1;
      try {
        await this.persist(this.snapshot(), { type: "execution-nonce-reserved",
          intentId, chainId, walletAddress: walletAddress.toLowerCase(), nonce });
      } catch (error) {
        this.mutationCount = previousMutationCount;
        if (existing) this.lanes.set(key, existing); else this.lanes.delete(key);
        throw error;
      }
      return nonce;
    });
  }

  async finalize(intentId) {
    const match = [...this.lanes.values()].find((lane) => lane.pending?.intentId === intentId);
    if (!match) return false;
    return this.serialize(async () => {
      const current = this.lanes.get(match.key);
      if (current?.pending?.intentId !== intentId) return false;
      const previous = { ...current, pending: { ...current.pending } };
      const previousMutationCount = this.mutationCount;
      this.lanes.set(match.key, { ...current, pending: null });
      this.mutationCount += 1;
      try {
        await this.persist(this.snapshot(), { type: "execution-nonce-finalized",
          intentId, chainId: current.chainId, walletAddress: current.walletAddress,
          nonce: current.pending.nonce });
      } catch (error) {
        this.mutationCount = previousMutationCount;
        this.lanes.set(match.key, previous);
        throw error;
      }
      return true;
    });
  }

  snapshot() {
    return { mutationCount: this.mutationCount,
      lanes: [...this.lanes.values()].map((lane) => ({
      ...lane, pending: lane.pending ? { ...lane.pending } : null,
    })) };
  }
}
