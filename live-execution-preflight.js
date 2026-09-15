import { decodeFunctionData, isAddressEqual } from "viem";
import { V2_ROUTER_ABI } from "./router-calldata.js";
import { quoteV2 } from "./v2-simulator.js";

const unique = (values) => [...new Set(values)];
const asBigInt = (value) => {
  try { return BigInt(String(value)); } catch { return null; }
};

export function assessLiveExecutionPreflight({
  intent,
  plan,
  chain,
  strategy,
  readiness,
  signing,
  sellProbe,
  now = Date.now(),
  maxSnapshotAgeMs = 15_000,
  maxBlockLag = 2,
  minimumNativeBalanceWei = "0",
  maximumAllowanceWei,
} = {}) {
  const failures = [];
  let call;
  try {
    call = decodeFunctionData({ abi: V2_ROUTER_ABI, data: intent?.data });
  } catch {
    failures.push("live-preflight-calldata-invalid");
  }
  if (call?.functionName !== "swapExactTokensForTokens") {
    failures.push("live-preflight-buy-call-required");
  }
  if (readiness?.eligibleForMicroMainnet !== true) failures.push("live-readiness-not-satisfied");
  if (signing?.credentialVerified !== true) failures.push("signing-credential-not-verified");
  if (signing?.policyVerified !== true) failures.push("signing-policy-not-verified");
  if (plan?.strategyApproved !== true) failures.push("live-strategy-not-approved");
  if (strategy?.approved !== true) failures.push("live-strategy-no-longer-approved");
  if (sellProbe?.passed !== true) failures.push("live-sell-probe-failed");
  const sellCheckedAt = Date.parse(String(sellProbe?.checkedAt || ""));
  if (!Number.isFinite(sellCheckedAt) || sellCheckedAt > now
      || now - sellCheckedAt > maxSnapshotAgeMs) failures.push("live-sell-probe-stale");

  const observedAt = Number(chain?.observedAt);
  if (!Number.isSafeInteger(observedAt) || observedAt > now
      || now - observedAt > maxSnapshotAgeMs) failures.push("live-chain-snapshot-stale");
  const blockNumber = Number(chain?.blockNumber);
  const latestBlock = Number(chain?.latestBlock);
  if (!Number.isSafeInteger(blockNumber) || !Number.isSafeInteger(latestBlock)
      || latestBlock < blockNumber || latestBlock - blockNumber > maxBlockLag) {
    failures.push("live-chain-snapshot-block-lag");
  }
  try {
    if (!isAddressEqual(chain.poolAddress, plan.poolAddress)
        || !isAddressEqual(chain.token0, plan.token0)
        || !isAddressEqual(chain.token1, plan.token1)) {
      failures.push("live-pool-identity-changed");
    }
  } catch { failures.push("live-pool-identity-invalid"); }

  const amountIn = call ? BigInt(call.args[0]) : null;
  const amountOutMin = call ? BigInt(call.args[1]) : null;
  const reserveIn = asBigInt(chain?.reserveIn);
  const reserveOut = asBigInt(chain?.reserveOut);
  if (amountIn == null || amountOutMin == null || reserveIn == null || reserveOut == null
      || reserveIn <= 0n || reserveOut <= 0n) {
    failures.push("live-reserves-invalid");
  } else {
    try {
      const currentOut = quoteV2({ reserveIn, reserveOut, amountIn,
        feeBps: plan.dex === "pancakeswap" ? 25 : 30 }).amountOut;
      if (currentOut < amountOutMin) failures.push("live-price-moved-below-minimum");
    } catch { failures.push("live-reserves-invalid"); }
  }

  const wethBalance = asBigInt(chain?.wethBalanceWei);
  const nativeBalance = asBigInt(chain?.nativeBalanceWei);
  const allowance = asBigInt(chain?.allowanceWei);
  const minimumNative = asBigInt(minimumNativeBalanceWei);
  const maximumAllowance = asBigInt(maximumAllowanceWei);
  if (amountIn == null || wethBalance == null || wethBalance < amountIn) {
    failures.push("live-weth-balance-insufficient");
  }
  if (nativeBalance == null || minimumNative == null || nativeBalance < minimumNative) {
    failures.push("live-native-gas-balance-insufficient");
  }
  if (amountIn == null || allowance == null || allowance < amountIn) {
    failures.push("live-router-allowance-insufficient");
  }
  if (allowance == null || maximumAllowance == null || maximumAllowance <= 0n
      || allowance > maximumAllowance) failures.push("live-router-allowance-exceeds-cap");
  return Object.freeze({ approved: failures.length === 0,
    failures: Object.freeze(unique(failures)), observedAt: Number.isSafeInteger(observedAt)
      ? observedAt : null, blockNumber: Number.isSafeInteger(blockNumber) ? blockNumber : null });
}

export function createLiveExecutionPreflight({ plans, inspect }) {
  if (!(plans instanceof Map) || typeof inspect !== "function") {
    throw new Error("invalid-live-preflight-config");
  }
  return async (intent, { now = Date.now() } = {}) => {
    const plan = plans.get(intent.id);
    if (!plan) return Object.freeze({ approved: false,
      failures: Object.freeze(["live-intent-plan-missing"]) });
    const evidence = await inspect(intent, plan, { now });
    return assessLiveExecutionPreflight({ intent, plan, ...evidence, now });
  };
}
