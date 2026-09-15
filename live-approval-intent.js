import { createHash } from "node:crypto";
import { encodeFunctionData, getAddress, isAddressEqual } from "viem";
import { APPROVE_ABI } from "./approval-calldata.js";
import { normalizeExecutionIntent } from "./execution-intent.js";

export function buildLiveExitApprovalIntent({ position, snapshot, config, now = Date.now(),
  expiryMs = 60_000 } = {}) {
  const token = getAddress(position?.baseToken);
  const router = getAddress(position?.routerAddress);
  const wallet = getAddress(config?.walletAddress);
  if (!(config?.allowedRouters || []).some((item) => isAddressEqual(item, router))) {
    throw new Error("live-router-not-allowed");
  }
  const amount = BigInt(String(position?.baseUnits || "0"));
  if (amount <= 0n) throw new Error("live-position-units-invalid");
  const identity = JSON.stringify({ entryIntentId: position.entryIntentId,
    token: token.toLowerCase(), router: router.toLowerCase(), amount: amount.toString(),
    blockNumber: Number(snapshot?.blockNumber) });
  if (!Number.isSafeInteger(Number(snapshot?.blockNumber))) {
    throw new Error("live-snapshot-block-invalid");
  }
  const id = `live:approve:${createHash("sha256").update(identity).digest("hex").slice(0, 48)}`;
  const data = encodeFunctionData({ abi: APPROVE_ABI, functionName: "approve",
    args: [router, amount] });
  return normalizeExecutionIntent({ id, purpose: "live-exit-approval",
    chainId: config.chainId, from: wallet, to: token, valueWei: "0",
    spendAsset: token, spendAmount: amount.toString(), data, expiresAt: now + expiryMs });
}
