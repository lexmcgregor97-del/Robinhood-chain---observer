const logIdentity = (log) => {
  const hash = String(log?.transactionHash || "").toLowerCase();
  const index = Number.parseInt(String(log?.logIndex || "0x0"), 16);
  if (!/^0x[0-9a-f]{64}$/.test(hash) || !Number.isInteger(index) || index < 0) {
    throw new Error("invalid-log-identity");
  }
  return `${hash}:${index}`;
};

export class LogDeduplicator {
  constructor({ retentionBlocks = 2_000, entries = [] } = {}) {
    this.retentionBlocks = retentionBlocks;
    this.entries = new Map(entries);
  }

  accept(log) {
    const id = logIdentity(log);
    if (this.entries.has(id)) return false;
    this.entries.set(id, Number(log.blockNumber));
    return true;
  }

  prune(latestBlock) {
    const floor = Number(latestBlock) - this.retentionBlocks;
    for (const [id, blockNumber] of this.entries) {
      if (Number(blockNumber) < floor) this.entries.delete(id);
    }
  }

  serialize() {
    return [...this.entries];
  }
}
