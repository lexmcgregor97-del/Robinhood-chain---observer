import { decodeFunctionData, isAddressEqual } from "viem";
import { V2_ROUTER_ABI } from "./router-calldata.js";
import { quoteV2 } from "./v2-simulator.js";

const unique = (values) => [...new Set(values)];

export function assessLiveExitPreflight({ intent, position, chain, signing,
  simulationPassed, now = Date.now(), maxSnapshotAgeMs = 15_000,
  maxBlockClockLagMs = 60_000, maxBlockLag = 2 } = {}) {
  const failures = [];
  let call;
  try { call = decodeFunctionData({ abi: V2_ROUTER_ABI, data: intent?.data }); }
  catch { failures.push("live-exit-calldata-invalid"); }
  if (call?.functionName !== "swapExactTokensForTokens") failures.push("live-exit-call-required");
  if (signing?.credentialVerified !== true) failures.push("signing-credential-not-verified");
  if (signing?.policyVerified !== true) failures.push("signing-policy-not-verified");
  if (simulationPassed !== true) failures.push("live-exit-simulation-failed");
  const observedAt = Number(chain?.observedAt);
  if (!Number.isSafeInteger(observedAt) || observedAt > now || now - observedAt > maxSnapshotAgeMs) {
    failures.push("live-chain-snapshot-stale");
  }
  const blockNumber = Number(chain?.blockNumber), latestBlock = Number(chain?.latestBlock);
  if (!Number.isSafeInteger(blockNumber) || !Number.isSafeInteger(latestBlock)
      || latestBlock < blockNumber || latestBlock - blockNumber > maxBlockLag) {
    failures.push("live-chain-snapshot-block-lag");
  }
  const blockTimestampMs = Number(chain?.blockTimestampMs);
  if (!Number.isSafeInteger(blockTimestampMs) || blockTimestampMs > now + 15_000
      || now - blockTimestampMs > maxBlockClockLagMs) failures.push("live-chain-head-stale");
  try {
    if (!isAddressEqual(chain.poolAddress, position.poolAddress)
        || !(isAddressEqual(position.baseToken, chain.token0)
          || isAddressEqual(position.baseToken, chain.token1))) {
      failures.push("live-position-chain-mismatch");
    }
    const amountIn = BigInt(call.args[0]), amountOutMin = BigInt(call.args[1]);
    if (amountIn !== BigInt(position.baseUnits)
        || !isAddressEqual(call.args[2][0], position.baseToken)
        || !isAddressEqual(call.args[2][1], chain.wethAddress)) {
      failures.push("live-exit-units-or-path-mismatch");
    }
    const baseIsToken0 = isAddressEqual(position.baseToken, chain.token0);
    const currentOut = quoteV2({ amountIn, feeBps: Number(position.feeBps),
      reserveIn: BigInt(baseIsToken0 ? chain.reserve0 : chain.reserve1),
      reserveOut: BigInt(baseIsToken0 ? chain.reserve1 : chain.reserve0) }).amountOut;
    if (currentOut < amountOutMin) failures.push("live-exit-price-moved-below-minimum");
    if (BigInt(chain.baseBalanceWei) < amountIn) failures.push("live-base-balance-insufficient");
    if (BigInt(chain.baseAllowanceWei) < amountIn
        || BigInt(chain.baseAllowanceWei) > amountIn) failures.push("live-base-allowance-not-exact");
  } catch { failures.push("live-exit-evidence-invalid"); }
  return Object.freeze({ approved: failures.length === 0,
    failures: Object.freeze(unique(failures)) });
}

export function assessLiveApprovalPreflight({ intent, position, chain, signing,
  simulationPassed, minimumNativeBalanceWei = "0", now = Date.now(),
  maxSnapshotAgeMs = 15_000 } = {}) {
  const failures = [];
  if (signing?.credentialVerified !== true || signing?.policyVerified !== true) {
    failures.push("signing-policy-not-verified");
  }
  if (simulationPassed !== true) failures.push("live-approval-simulation-failed");
  if (Number(chain?.observedAt) > now || now - Number(chain?.observedAt) > maxSnapshotAgeMs) {
    failures.push("live-chain-snapshot-stale");
  }
  try {
    if (BigInt(chain.baseBalanceWei) < BigInt(position.baseUnits)) {
      failures.push("live-base-balance-insufficient");
    }
    if (BigInt(chain.nativeBalanceWei) < BigInt(minimumNativeBalanceWei)) {
      failures.push("live-native-gas-balance-insufficient");
    }
    if (!isAddressEqual(intent.to, position.baseToken)) failures.push("live-approval-token-mismatch");
  } catch { failures.push("live-approval-evidence-invalid"); }
  return Object.freeze({ approved: failures.length === 0,
    failures: Object.freeze(unique(failures)) });
}
