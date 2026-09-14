import test from "node:test";
import assert from "node:assert/strict";
import { normalizeExecutionIntent } from "./execution-intent.js";

const base = {
  id: "swap:1",
  purpose: "micro-entry",
  chainId: 4663,
  from: "0x1111111111111111111111111111111111111111",
  to: "0x2222222222222222222222222222222222222222",
  valueWei: "1000",
  spendAsset: "native",
  spendAmount: "1000",
  data: "0x12345678",
  expiresAt: 10_000,
};

test("normalizes an EVM execution intent", () => {
  const intent = normalizeExecutionIntent(base);
  assert.equal(intent.selector, "0x12345678");
  assert.equal(intent.kind, "evm-transaction");
  assert.equal(intent.valueWei, "1000");
  assert.equal(intent.spendAsset, "native");
});

test("rejects malformed addresses, calldata, values, and expiry", () => {
  assert.throws(() => normalizeExecutionIntent({ ...base, to: "0x1234" }), /invalid-to/);
  assert.throws(() => normalizeExecutionIntent({ ...base, data: "0x123" }), /invalid-calldata/);
  assert.throws(() => normalizeExecutionIntent({ ...base, valueWei: "-1" }), /invalid-value-wei/);
  assert.throws(() => normalizeExecutionIntent({ ...base, spendAsset: "ETH" }), /invalid-spend-asset/);
  assert.throws(() => normalizeExecutionIntent({ ...base, spendAmount: "0" }), /invalid-spend-amount/);
  assert.throws(() => normalizeExecutionIntent({ ...base, expiresAt: 0 }), /invalid-expiry/);
});
