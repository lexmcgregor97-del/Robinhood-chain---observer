import test from "node:test";
import assert from "node:assert/strict";
import { gasMeasurementFromEnv } from "./gas-measurement.js";

const now = Date.parse("2026-09-14T22:00:00Z");

test("requires a recent on-chain transaction reference for configured gas assumptions", () => {
  assert.equal(gasMeasurementFromEnv({}, now).verifiedInput, false);
  const measured = gasMeasurementFromEnv({
    PAPER_GAS_MEASUREMENT_TX: `0x${"a".repeat(64)}`,
    PAPER_GAS_MEASURED_AT: "2026-09-14T21:00:00Z",
  }, now);
  assert.equal(measured.verifiedInput, true);
});

test("rejects stale gas measurements", () => {
  const measured = gasMeasurementFromEnv({
    PAPER_GAS_MEASUREMENT_TX: `0x${"a".repeat(64)}`,
    PAPER_GAS_MEASURED_AT: "2026-08-01T00:00:00Z",
  }, now);
  assert.ok(measured.failures.includes("gas-measurement-stale"));
});
