import test from "node:test";
import assert from "node:assert/strict";
import { LogDeduplicator } from "./log-deduplicator.js";

const hash = `0x${"ab".repeat(32)}`;
const log = { transactionHash: hash, logIndex: "0x2", blockNumber: 100 };

test("deduplicates a log across serialized restarts", () => {
  const first = new LogDeduplicator();
  assert.equal(first.accept(log), true);
  assert.equal(first.accept(log), false);
  const restored = new LogDeduplicator({ entries: first.serialize() });
  assert.equal(restored.accept(log), false);
});

test("prunes identities outside the restart replay horizon", () => {
  const dedup = new LogDeduplicator({ retentionBlocks: 10 });
  dedup.accept(log);
  dedup.prune(111);
  assert.equal(dedup.serialize().length, 0);
  assert.equal(dedup.accept(log), true);
});

test("fails closed on malformed log identity", () => {
  const dedup = new LogDeduplicator();
  assert.throws(() => dedup.accept({ blockNumber: 1 }), /invalid-log-identity/);
});
