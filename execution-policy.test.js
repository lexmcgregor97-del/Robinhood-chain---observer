import test from "node:test";
import assert from "node:assert/strict";
import { evaluateExecutionPolicy } from "./execution-policy.js";

const wallet = "0x1111111111111111111111111111111111111111";
const router = "0x2222222222222222222222222222222222222222";
const intent = {
  id: "swap:1", purpose: "micro-entry", chainId: 4663, from: wallet, to: router,
  valueWei: "100", data: "0x12345678", expiresAt: 50_000,
  spendAsset: "native", spendAmount: "100",
};
const policy = {
  walletAddress: wallet,
  allowedChainIds: [4663],
  allowedCalls: { [router]: ["0x12345678"] },
  maxValueWei: "200",
  spendLimits: { native: { maxPerTransaction: "200", maxDaily: "500" } },
  maxExpiryMs: 60_000,
};

test("approves only a bounded allowlisted intent", () => {
  assert.equal(evaluateExecutionPolicy(intent, policy, { now: 1_000 }).approved, true);
  assert.deepEqual(
    evaluateExecutionPolicy({ ...intent, to: wallet }, policy, { now: 1_000 }).failures,
    ["router-not-allowed"],
  );
  assert.ok(evaluateExecutionPolicy(intent, policy, {
    now: 1_000, dailySpent: "450",
  }).failures.includes("daily-spend-limit"));
});

test("rejects wrong wallet, chain, selector, expiry, and value", () => {
  const result = evaluateExecutionPolicy({
    ...intent, chainId: 1, from: router, data: "0x87654321",
    valueWei: "201", spendAmount: "201", expiresAt: 100_000,
  }, policy, { now: 1_000 });
  assert.equal(result.approved, false);
  assert.deepEqual(result.failures, [
    "chain-not-allowed", "wallet-mismatch", "selector-not-allowed",
    "expiry-too-distant", "transaction-value-limit", "transaction-spend-limit",
  ]);
});

test("supports an explicit position-unit limit without claiming a daily risk budget", () => {
  const exitPolicy = { ...policy,
    spendLimits: { native: { maxPerTransaction: "200", trackDaily: false } } };
  assert.equal(evaluateExecutionPolicy(intent, exitPolicy,
    { now: 1_000, dailySpent: "999999" }).approved, true);
});
