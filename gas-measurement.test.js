import test from "node:test";
import assert from "node:assert/strict";
import { gasMeasurementFromEnv, verifyGasMeasurement } from "./gas-measurement.js";

const now = Date.parse("2026-09-14T22:00:00Z");
const tx = `0x${"a".repeat(64)}`;
const router = `0x${"b".repeat(40)}`;
const config = gasMeasurementFromEnv({ PAPER_GAS_MEASUREMENT_TX: tx,
  PAPER_V2_ROUTER_ADDRESSES: router, PAPER_WETH_GAS_PER_SIDE: "0.001" });
const receipt = { status: "0x1", to: router, blockNumber: "0x64",
  gasUsed: "0x186a0", effectiveGasPrice: "0x3b9aca00", l1Fee: "0x3b9aca00" };

test("a plausible hash alone never verifies gas", async () => {
  const weak = gasMeasurementFromEnv({ PAPER_GAS_MEASUREMENT_TX: tx,
    PAPER_WETH_GAS_PER_SIDE: "0.000000001" });
  assert.equal(weak.configured, false);
  assert.ok(weak.failures.includes("gas-v2-router-allowlist-required"));
});

test("verifies receipt status, router, block age, L1 fee, and configured floor", async () => {
  const result = await verifyGasMeasurement({ config, now,
    getReceipt: async () => receipt,
    getBlock: async () => ({ timestamp: `0x${Math.floor(now / 1000).toString(16)}` }),
  });
  assert.equal(result.verifiedInput, true);
  assert.equal(result.observedCostWei, "100001000000000");
  assert.equal("transactionHash" in result, false);
});

test("fails closed without the chain's L1 fee component", async () => {
  const { l1Fee, ...missingL1 } = receipt;
  const result = await verifyGasMeasurement({ config, now,
    getReceipt: async () => missingL1,
    getBlock: async () => ({ timestamp: `0x${Math.floor(now / 1000).toString(16)}` }),
  });
  assert.equal(result.verifiedInput, false);
  assert.ok(result.failures.includes("gas-l1-component-unverified"));
});

test("accepts Nitro L1 gas only as a sub-component of total gasUsed", async () => {
  const { l1Fee, ...nitro } = receipt;
  nitro.gasUsedForL1 = "0x2710";
  const result = await verifyGasMeasurement({ config, now,
    getReceipt: async () => nitro,
    getBlock: async () => ({ timestamp: `0x${Math.floor(now / 1000).toString(16)}` }),
  });
  assert.equal(result.verifiedInput, true);
  assert.equal(result.observedCostWei, "100000000000000");
  assert.equal("receiptBlock" in result, false);
  assert.equal("router" in result, false);
  assert.ok(result.lastVerifiedAt);
});

test("rejects an impossible Nitro L1 sub-component", async () => {
  const { l1Fee, ...nitro } = receipt;
  nitro.gasUsedForL1 = "0x186a1";
  const result = await verifyGasMeasurement({ config, now,
    getReceipt: async () => nitro,
    getBlock: async () => ({ timestamp: `0x${Math.floor(now / 1000).toString(16)}` }),
  });
  assert.equal(result.verifiedInput, false);
  assert.ok(result.failures.includes("gas-l1-component-invalid"));
});

test("rejects stale, failed, wrong-router, and underpriced measurements", async () => {
  const low = { ...config, configuredWethPerSide: 1e-12 };
  const result = await verifyGasMeasurement({ config: low, now,
    getReceipt: async () => ({ ...receipt, status: "0x0", to: `0x${"c".repeat(40)}` }),
    getBlock: async () => ({ timestamp: "0x1" }),
  });
  for (const failure of ["gas-measurement-transaction-failed", "gas-measurement-router-not-allowed",
    "gas-measurement-stale", "gas-weth-assumption-below-observed"]) {
    assert.ok(result.failures.includes(failure), failure);
  }
});
