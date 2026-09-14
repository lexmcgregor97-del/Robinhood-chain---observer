import { normalizeExecutionIntent } from "./execution-intent.js";

const lowerSet = (values = []) => new Set(values.map((value) => String(value).toLowerCase()));

export function evaluateExecutionPolicy(rawIntent, policy, {
  now = Date.now(),
  dailySpentWei = "0",
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
  const dailySpent = BigInt(String(dailySpentWei));
  const maxValue = BigInt(String(policy.maxValueWei ?? "0"));
  const maxDaily = BigInt(String(policy.maxDailySpendWei ?? "0"));

  if (!allowedChains.has(intent.chainId)) failures.push("chain-not-allowed");
  if (intent.from !== walletAddress) failures.push("wallet-mismatch");
  const routerSelectors = allowedCalls.get(intent.to);
  if (!routerSelectors) failures.push("router-not-allowed");
  else if (!routerSelectors.has(intent.selector)) failures.push("selector-not-allowed");
  if (intent.expiresAt <= now) failures.push("intent-expired");
  if (intent.expiresAt > now + maxExpiryMs) failures.push("expiry-too-distant");
  if (value > maxValue) failures.push("transaction-value-limit");
  if (dailySpent + value > maxDaily) failures.push("daily-spend-limit");

  return { approved: failures.length === 0, failures, intent };
}

export class DisabledSigner {
  async sign() {
    throw new Error("atlas-signer-disabled");
  }

  async broadcast() {
    throw new Error("atlas-broadcast-disabled");
  }
}
