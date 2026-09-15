import test from "node:test";
import assert from "node:assert/strict";
import { workerObserverAuthorized } from "./worker-observer-auth.js";

test("accepts only the exact 32+ character worker bearer credential", () => {
  const token = "a".repeat(32);
  assert.equal(workerObserverAuthorized(`Bearer ${token}`, token), true);
  assert.equal(workerObserverAuthorized(`Bearer ${token}x`, token), false);
  assert.equal(workerObserverAuthorized(token, token), false);
  assert.equal(workerObserverAuthorized("Bearer short", "short"), false);
});
