import test from "node:test";
import assert from "node:assert/strict";
import { executionIntentTransactionDigest } from "./execution-transaction-digest.js";

const intent = { chainId: 4663,
  from: "0x1111111111111111111111111111111111111111",
  to: "0x2222222222222222222222222222222222222222",
  data: "0x12345678", value: 0n };

test("canonically binds every execution-intent transaction field", () => {
  const digest = executionIntentTransactionDigest(intent);
  assert.match(digest, /^0x[0-9a-f]{64}$/);
  for (const changed of [
    { chainId: 1 },
    { from: "0x3333333333333333333333333333333333333333" },
    { to: "0x3333333333333333333333333333333333333333" },
    { data: "0xdeadbeef" },
    { value: 1n },
  ]) assert.notEqual(executionIntentTransactionDigest({ ...intent, ...changed }), digest);
});

test("rejects malformed digest inputs", () => {
  for (const changed of [{ chainId: 0 }, { from: "bad" }, { data: "0x1" }, { value: -1n }]) {
    assert.throws(() => executionIntentTransactionDigest({ ...intent, ...changed }),
      /execution-intent-digest-input-invalid/);
  }
});
