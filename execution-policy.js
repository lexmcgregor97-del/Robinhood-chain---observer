import { normalizeExecutionIntent } from "./execution-intent.js";

const lowerSet = (values = []) => new Set(values.map((value) => String(value).toLowerCase()));

export function evaluateExecutionPolicy(rawIntent, policy, {
  now = Date.now(),
  dailySpent = "0",
} = {}) {
  const failures = [];
  let intent;
  try {
    intent = normalizeExecutionIntent(rawIntent);
  } catch (error) {
    return { approved: false, failures: [error.message], intent: null };
  }

  const allowedChains = new Set(policy.allowedChainIds || []);
  const allowedCalls = new Map(Object.entries(policy.allowedCalls || {}).map(
    ([router, selectors]) => [router.toLowerCase(), lowerSet(selectors)],
  ));
  const walletAddress = String(policy.walletAddress || "").toLowerCase();
  const maxExpiryMs = Number(policy.maxExpiryMs || 60_000);
  const value = BigInt(intent.valueWei);
  const maxValue = BigInt(String(policy.maxValueWei ?? "0"));
  const spendLimit = Object.fromEntries(Object.entries(policy.spendLimits || {}).map(
    ([asset, limit]) => [asset.toLowerCase(), limit],
  ))[intent.spendAsset];

  if (!allowedChains.has(intent.chainId)) failures.push("chain-not-allowed");
  if (intent.from !== walletAddress) failures.push("wallet-mismatch");
  const routerSelectors = allowedCalls.get(intent.to);
  if (!routerSelectors) failures.push("router-not-allowed");
  else if (!routerSelectors.has(intent.selector)) failures.push("selector-not-allowed");
  if (intent.expiresAt <= now) failures.push("intent-expired");
  if (intent.expiresAt > now + maxExpiryMs) failures.push("expiry-too-distant");
  if (value > maxValue) failures.push("transaction-value-limit");
  if (!spendLimit) failures.push("spend-asset-not-allowed");
  else {
    const amount = BigInt(intent.spendAmount);
    if (amount > BigInt(String(spendLimit.maxPerTransaction ?? "0"))) {
      failures.push("transaction-spend-limit");
    }
    if (spendLimit.trackDaily !== false
        && BigInt(String(dailySpent)) + amount > BigInt(String(spendLimit.maxDaily ?? "0"))) {
      failures.push("daily-spend-limit");
    }
  }

  return { approved: failures.length === 0, failures, intent };
}
