import test from "node:test";
import assert from "node:assert/strict";
import { envFlag } from "./runtime-flags.js";

test("runtime flags use an explicit fallback", () => {
  assert.equal(envFlag(undefined), false);
  assert.equal(envFlag(undefined, true), true);
});

test("runtime flags accept explicit enable and disable values", () => {
  for (const value of ["1", "true", "TRUE", "yes", "on"]) {
    assert.equal(envFlag(value), true);
  }
  for (const value of ["0", "false", "FALSE", "no", "off"]) {
    assert.equal(envFlag(value), false);
  }
});

test("runtime flags fail closed on malformed values", () => {
  assert.throws(() => envFlag("sometimes"), /Invalid boolean environment flag/);
});

