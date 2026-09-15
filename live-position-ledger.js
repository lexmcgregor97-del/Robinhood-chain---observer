import { createExecutionMutationSerializer } from "./execution-mutation-queue.js";

const ADDRESS = /^0x[0-9a-f]{40}$/;
const UINT = /^(0|[1-9][0-9]*)$/;
const clone = (value) => structuredClone(value);
const positiveUint = (value, failure) => {
  const text = String(value ?? "");
  if (!UINT.test(text) || BigInt(text) <= 0n) throw new Error(failure);
  return text;
};
const address = (value, failure) => {
  const text = String(value || "").toLowerCase();
  if (!ADDRESS.test(text)) throw new Error(failure);
  return text;
};

export class LivePositionLedger {
  constructor(state = {}, { persist = async () => {},
    serialize = createExecutionMutationSerializer() } = {}) {
    if (typeof persist !== "function" || typeof serialize !== "function") {
      throw new Error("invalid-live-position-ledger-config");
    }
    this.persist = persist;
    this.serialize = serialize;
    this.mutationCount = Number(state.mutationCount || 0);
    if (!Number.isSafeInteger(this.mutationCount) || this.mutationCount < 0) {
      throw new Error("invalid-live-position-state");
    }
    this.positions = new Map();
    this.history = Array.isArray(state.history) ? clone(state.history) : [];
    this.processedIntentIds = new Set(state.processedIntentIds || []);
    if (this.processedIntentIds.size !== (state.processedIntentIds || []).length
        || [...this.processedIntentIds].some((id) => !id)) {
      throw new Error("invalid-live-position-state");
    }
    for (const raw of state.positions || []) {
      const position = this.validate(raw);
      if (this.positions.has(position.poolAddress)) throw new Error("invalid-live-position-state");
      this.positions.set(position.poolAddress, position);
    }
  }

  validate(raw) {
    const position = { ...clone(raw), poolAddress: address(raw?.poolAddress,
      "invalid-live-position-state"), baseToken: address(raw?.baseToken,
      "invalid-live-position-state"), routerAddress: address(raw?.routerAddress,
      "invalid-live-position-state"), baseUnits: positiveUint(raw?.baseUnits,
      "invalid-live-position-state"), entryWethWei: positiveUint(raw?.entryWethWei,
      "invalid-live-position-state"), peakWethOutWei: positiveUint(raw?.peakWethOutWei,
      "invalid-live-position-state") };
    if (!position.entryIntentId || !position.entryTransactionHash
        || !Number.isSafeInteger(Number(position.openedAt))
        || !new Set(["open", "exit-requested"]).has(position.status)) {
      throw new Error("invalid-live-position-state");
    }
    return position;
  }

  mutate(operation) { return this.serialize(operation); }

  async apply(poolAddress, next, type, now, processedIntentId = null, historyRecord = null) {
    const key = address(poolAddress, "live-position-pool-invalid");
    const previous = this.positions.get(key);
    const previousCount = this.mutationCount;
    const wasProcessed = processedIntentId ? this.processedIntentIds.has(processedIntentId) : false;
    if (next == null) this.positions.delete(key);
    else this.positions.set(key, this.validate(next));
    this.mutationCount += 1;
    if (processedIntentId) this.processedIntentIds.add(processedIntentId);
    if (historyRecord) this.history.push(clone(historyRecord));
    try {
      await this.persist(this.snapshot(), { type, poolAddress: key,
        position: historyRecord ? clone(historyRecord)
          : next == null ? null : clone(this.positions.get(key)), recordedAt: Number(now) });
    } catch (error) {
      this.mutationCount = previousCount;
      if (processedIntentId && !wasProcessed) this.processedIntentIds.delete(processedIntentId);
      if (historyRecord) this.history.pop();
      if (previous) this.positions.set(key, previous); else this.positions.delete(key);
      throw error;
    }
    return next == null ? null : Object.freeze(clone(this.positions.get(key)));
  }

  open(input, now = Date.now()) {
    return this.mutate(async () => {
      const poolAddress = address(input?.poolAddress, "live-position-pool-invalid");
      if (this.processedIntentIds.has(input?.entryIntentId)) return null;
      if (this.positions.has(poolAddress)) throw new Error("live-position-already-open");
      const position = { ...clone(input), poolAddress, status: "open",
        openedAt: Number(input.openedAt ?? now), peakWethOutWei: String(input.entryWethWei) };
      return this.apply(poolAddress, position, "live-position-opened", now, input.entryIntentId);
    });
  }

  mark(poolAddress, wethOutWei, now = Date.now()) {
    return this.mutate(async () => {
      const key = address(poolAddress, "live-position-pool-invalid");
      const current = this.positions.get(key);
      if (!current || current.status !== "open") throw new Error("live-position-not-open");
      const output = positiveUint(wethOutWei, "live-position-mark-invalid");
      const next = { ...current, lastMarkedAt: Number(now), lastWethOutWei: output,
        peakWethOutWei: (BigInt(output) > BigInt(current.peakWethOutWei)
          ? output : current.peakWethOutWei) };
      return this.apply(key, next, "live-position-marked", now);
    });
  }

  requestExit(poolAddress, { reason, intentId }, now = Date.now()) {
    return this.mutate(async () => {
      const key = address(poolAddress, "live-position-pool-invalid");
      const current = this.positions.get(key);
      if (!current || current.status !== "open" || !reason || !intentId) {
        throw new Error("live-position-exit-invalid");
      }
      return this.apply(key, { ...current, status: "exit-requested", exitReason: reason,
        exitIntentId: intentId, exitRequestedAt: Number(now) },
      "live-position-exit-requested", now);
    });
  }

  close(poolAddress, { intentId, transactionHash, wethReceivedWei }, now = Date.now()) {
    return this.mutate(async () => {
      const key = address(poolAddress, "live-position-pool-invalid");
      const current = this.positions.get(key);
      if (!current || current.status !== "exit-requested" || current.exitIntentId !== intentId) {
        throw new Error("live-position-close-invalid");
      }
      positiveUint(wethReceivedWei, "live-position-proceeds-invalid");
      const closed = { ...clone(current), status: "closed", closedAt: Number(now),
        exitTransactionHash: transactionHash, wethReceivedWei: String(wethReceivedWei) };
      await this.apply(key, null, "live-position-closed", now, intentId, closed);
      return Object.freeze(closed);
    });
  }

  cancelExit(poolAddress, intentId, now = Date.now()) {
    return this.mutate(async () => {
      const key = address(poolAddress, "live-position-pool-invalid");
      const current = this.positions.get(key);
      if (!current || current.status !== "exit-requested" || current.exitIntentId !== intentId) {
        throw new Error("live-position-exit-cancel-invalid");
      }
      const { exitReason: _reason, exitIntentId: _intent, exitRequestedAt: _at, ...rest } = current;
      return this.apply(key, { ...rest, status: "open" }, "live-position-exit-cancelled", now);
    });
  }

  get(poolAddress) {
    const value = this.positions.get(String(poolAddress || "").toLowerCase());
    return value ? Object.freeze(clone(value)) : null;
  }
  hasProcessed(intentId) { return this.processedIntentIds.has(String(intentId || "")); }

  openPositions() { return [...this.positions.values()].map((item) => Object.freeze(clone(item))); }
  snapshot() { return { mutationCount: this.mutationCount,
    processedIntentIds: [...this.processedIntentIds],
    positions: [...this.positions.values()].map(clone), history: clone(this.history) }; }
}
