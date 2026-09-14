import test from "node:test";
import assert from "node:assert/strict";
import { assessReadiness } from "./readiness.js";

test("is ready only when synchronized and RPC healthy", () => {
  assert.deepEqual(assessReadiness({
    latestBlock: 100, cursor: 100, backfillActive: false, lastError: null,
  }), {
    synchronized: true, rpcHealthy: true, readyForPaper: true, lagBlocks: 0, reasons: [],
  });
});

test("reports explicit startup and degraded reasons", () => {
  assert.deepEqual(assessReadiness({
    latestBlock: 0, cursor: 50, backfillActive: true, lastError: "RPC HTTP 429",
  }).reasons, ["latest-block-unavailable", "backfill-active", "rpc-error"]);
  const behind = assessReadiness({
    latestBlock: 100, cursor: 90, backfillActive: false, lastError: null,
  });
  assert.equal(behind.readyForPaper, false);
  assert.equal(behind.lagBlocks, 10);
  assert.ok(behind.reasons.includes("scanner-behind"));
});
