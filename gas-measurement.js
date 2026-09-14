const TX_HASH = /^0x[0-9a-f]{64}$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;

const hexBigInt = (value, name) => {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) throw new Error(name);
  return BigInt(value);
};

export function gasMeasurementFromEnv(env = process.env) {
  const transactionHash = String(env.PAPER_GAS_MEASUREMENT_TX || "").toLowerCase();
  const maxAgeMs = Number(env.PAPER_GAS_MAX_AGE_MS || 7 * 24 * 60 * 60_000);
  const configuredWethPerSide = Number(env.PAPER_WETH_GAS_PER_SIDE || "");
  const allowedRouters = String(env.PAPER_V2_ROUTER_ADDRESSES || "")
    .split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  const failures = [];
  if (!TX_HASH.test(transactionHash)) failures.push("gas-measurement-transaction-required");
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) failures.push("invalid-gas-measurement-max-age");
  if (!allowedRouters.length || allowedRouters.some((value) => !ADDRESS.test(value))) {
    failures.push("gas-v2-router-allowlist-required");
  }
  if (!Number.isFinite(configuredWethPerSide) || configuredWethPerSide <= 0) {
    failures.push("gas-weth-assumption-required");
  }
  return { transactionHash: TX_HASH.test(transactionHash) ? transactionHash : null,
    maxAgeMs, configuredWethPerSide: Number.isFinite(configuredWethPerSide)
      ? configuredWethPerSide : null,
    allowedRouters, configured: failures.length === 0, failures };
}

export async function verifyGasMeasurement({ config, getReceipt, getBlock, now = Date.now() }) {
  const failures = [...(config?.failures || [])];
  let receipt = null;
  let observedCostWei = null;
  let observedCostWeth = null;
  let router = null;
  let measuredAt = null;
  try {
    if (!failures.length) {
      receipt = await getReceipt(config.transactionHash);
      if (!receipt) throw new Error("gas-measurement-receipt-unavailable");
      if (hexBigInt(receipt.status, "gas-receipt-status-invalid") !== 1n) {
        failures.push("gas-measurement-transaction-failed");
      }
      router = String(receipt.to || "").toLowerCase();
      if (!config.allowedRouters.includes(router)) failures.push("gas-measurement-router-not-allowed");
      const block = await getBlock(receipt.blockNumber);
      const blockTimestampMs = Number(hexBigInt(block?.timestamp, "gas-block-time-invalid")) * 1_000;
      measuredAt = Number.isFinite(blockTimestampMs) ? new Date(blockTimestampMs).toISOString() : null;
      const ageMs = now - blockTimestampMs;
      if (!Number.isFinite(ageMs) || ageMs < -5 * 60_000 || ageMs > config.maxAgeMs) {
        failures.push("gas-measurement-stale");
      }
      const gasUsed = hexBigInt(receipt.gasUsed, "gas-used-invalid");
      const executionWei = gasUsed
        * hexBigInt(receipt.effectiveGasPrice, "gas-price-invalid");
      if (receipt.l1Fee != null) {
        // OP-style receipts expose an additional L1 fee.
        observedCostWei = executionWei + hexBigInt(receipt.l1Fee, "gas-l1-fee-invalid");
      } else if (receipt.gasUsedForL1 != null) {
        // Nitro/Orbit receipts fold the L1 component into gasUsed. Prove that
        // the reported L1 gas is a sub-component and do not add it twice.
        const gasUsedForL1 = hexBigInt(receipt.gasUsedForL1, "gas-l1-used-invalid");
        if (gasUsedForL1 > gasUsed) failures.push("gas-l1-component-invalid");
        else observedCostWei = executionWei;
      } else failures.push("gas-l1-component-unverified");
      if (observedCostWei !== null) {
        observedCostWeth = Number(observedCostWei) / 1e18;
        if (!Number.isFinite(observedCostWeth)
            || config.configuredWethPerSide < observedCostWeth) {
          failures.push("gas-weth-assumption-below-observed");
        }
      }
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  const verifiedInput = failures.length === 0;
  return { verifiedInput, measuredAt,
    lastVerifiedAt: verifiedInput ? new Date(now).toISOString() : null,
    observedCostWei: observedCostWei?.toString() || null, observedCostWeth,
    configuredWethPerSide: config?.configuredWethPerSide ?? null,
    failures: [...new Set(failures)] };
}
