import { getAddress, isAddressEqual } from "viem";
import { ROBINHOOD } from "./chain-config.js";
import { microMainnetConfigFromEnv } from "./micro-mainnet-config.js";
import { envFlag } from "./runtime-flags.js";
import { DEFAULT_LIVE_EXIT_POLICY } from "./live-exit-policy.js";

const UINT = /^(0|[1-9][0-9]*)$/;
const positive = (value, name) => {
  const text = String(value || "");
  if (!UINT.test(text) || BigInt(text) <= 0n) throw new Error(`live-worker-${name}-invalid`);
  return text;
};
const integer = (value, fallback, name) => {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`live-worker-${name}-invalid`);
  return parsed;
};

export const LIVE_WORKER_CONFIRMATION_PREFIX = "CONNECT_ATLAS_PRIVATE_WORKER";

export function liveWorkerConfigFromEnv(env = process.env) {
  const execution = microMainnetConfigFromEnv(env);
  const connected = envFlag(env.LIVE_WORKER_SUBMISSION_CONNECTED, false);
  const automatic = envFlag(env.LIVE_WORKER_AUTOMATIC_SUBMISSION_ENABLED, false);
  const failures = [...execution.failures];
  const observerUrl = String(env.ATLAS_OBSERVER_URL || "").trim();
  const observerHostname = String(env.LIVE_WORKER_OBSERVER_HOSTNAME || "").trim().toLowerCase();
  const observerBearerToken = String(env.LIVE_WORKER_OBSERVER_BEARER_TOKEN || "");
  const statePath = String(env.LIVE_WORKER_STATE_FILE || "").trim();
  const evidencePath = String(env.LIVE_WORKER_EVIDENCE_FILE || "").trim();
  let routerAddress = "";
  try { routerAddress = getAddress(env.LIVE_WORKER_V2_ROUTER_ADDRESS).toLowerCase(); }
  catch { failures.push("live-worker-router-invalid"); }
  if (routerAddress && !execution.allowedRouters.some((item) =>
    isAddressEqual(item, routerAddress))) failures.push("live-worker-router-not-allowed");
  if (!observerHostname) failures.push("live-worker-observer-hostname-required");
  if (!observerUrl) failures.push("live-worker-observer-url-required");
  else {
    try {
      const parsed = new URL(observerUrl);
      if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") throw new Error();
      if (parsed.hostname.toLowerCase() !== observerHostname) {
        failures.push("live-worker-observer-hostname-mismatch");
      }
    } catch { failures.push("live-worker-observer-url-invalid"); }
  }
  if (observerBearerToken.length < 32) failures.push("live-worker-observer-bearer-invalid");
  if (!statePath || !evidencePath || statePath === evidencePath) {
    failures.push("live-worker-storage-paths-invalid");
  }
  let amountInWei = "", maximumAllowanceWei = "", minimumNativeBalanceWei = "";
  try { amountInWei = positive(env.LIVE_WORKER_BUY_AMOUNT_WEI, "buy-amount"); }
  catch (error) { failures.push(error.message); }
  try { maximumAllowanceWei = positive(env.LIVE_WORKER_MAX_ALLOWANCE_WEI, "allowance-cap"); }
  catch (error) { failures.push(error.message); }
  try { minimumNativeBalanceWei = positive(env.LIVE_WORKER_MIN_NATIVE_BALANCE_WEI,
    "native-balance-floor"); } catch (error) { failures.push(error.message); }
  if (UINT.test(amountInWei) && UINT.test(execution.maxPerTransactionWei)
      && BigInt(amountInWei) > BigInt(execution.maxPerTransactionWei)) {
    failures.push("live-worker-buy-exceeds-transaction-cap");
  }
  if (UINT.test(maximumAllowanceWei) && UINT.test(execution.maxDailyWei)
      && BigInt(maximumAllowanceWei) > BigInt(execution.maxDailyWei)) {
    failures.push("live-worker-allowance-exceeds-daily-cap");
  }
  const confirmation = String(env.LIVE_WORKER_CONFIRMATION || "");
  const expectedConfirmation = execution.walletAddress
    ? `${LIVE_WORKER_CONFIRMATION_PREFIX}:${ROBINHOOD.chainId}:${execution.walletAddress}` : null;
  if (connected && confirmation !== expectedConfirmation) failures.push("live-worker-confirmation-mismatch");
  const exitPathConnected = true;
  if (connected && !exitPathConnected) failures.push("live-worker-exit-path-not-connected");
  if (automatic && !connected) failures.push("live-worker-submission-path-required");
  if (connected && !execution.configured) failures.push("micro-mainnet-config-incomplete");
  const numeric = {};
  for (const [key, value, fallback] of [
    ["pollIntervalMs", env.LIVE_WORKER_POLL_INTERVAL_MS, 15_000],
    ["failureBackoffMaxMs", env.LIVE_WORKER_FAILURE_BACKOFF_MAX_MS, 15 * 60_000],
    ["failureStopThreshold", env.LIVE_WORKER_FAILURE_STOP_THRESHOLD, 10],
    ["deadlineSeconds", env.LIVE_WORKER_DEADLINE_SECONDS, 60],
    ["slippageBps", env.LIVE_WORKER_SLIPPAGE_BPS, 300],
    ["exitStopLossPct", env.LIVE_WORKER_EXIT_STOP_LOSS_PCT,
      DEFAULT_LIVE_EXIT_POLICY.stopLossPct],
    ["exitTakeProfitPct", env.LIVE_WORKER_EXIT_TAKE_PROFIT_PCT,
      DEFAULT_LIVE_EXIT_POLICY.takeProfitPct],
    ["exitTrailingActivationPct", env.LIVE_WORKER_EXIT_TRAILING_ACTIVATION_PCT,
      DEFAULT_LIVE_EXIT_POLICY.trailingActivationPct],
    ["exitTrailingDrawdownPct", env.LIVE_WORKER_EXIT_TRAILING_DRAWDOWN_PCT,
      DEFAULT_LIVE_EXIT_POLICY.trailingDrawdownPct],
    ["exitMaxHoldMs", env.LIVE_WORKER_EXIT_MAX_HOLD_MS, DEFAULT_LIVE_EXIT_POLICY.maxHoldMs],
    ["signalLookbackBlocks", env.LIVE_WORKER_SIGNAL_LOOKBACK_BLOCKS, 3_000],
    ["signalWindowMs", env.LIVE_WORKER_SIGNAL_WINDOW_MS, 60_000],
    ["signalBaselineMs", env.LIVE_WORKER_SIGNAL_BASELINE_MS, 300_000],
    ["signalMinSwaps", env.LIVE_WORKER_SIGNAL_MIN_SWAPS, 3],
    ["sellProbeMaxSwapAgeBlocks", env.SELL_PROBE_MAX_SWAP_AGE_BLOCKS, 1_200],
    ["sellProbeMaxSlippageBps", env.SELL_PROBE_MAX_SLIPPAGE_BPS, 500],
    ["sellProbeMaxStorageSlot", env.SELL_PROBE_MAX_STORAGE_SLOT, 24],
    ["sellProbeNegativeCacheMs", env.SELL_PROBE_NEGATIVE_CACHE_MS, 60 * 60_000],
  ]) {
    try { numeric[key] = integer(value, fallback, key); }
    catch (error) { failures.push(error.message); }
  }
  if (numeric.deadlineSeconds > 60) failures.push("live-worker-deadline-too-long");
  if (numeric.slippageBps > 2_000) failures.push("live-worker-slippage-too-high");
  if (numeric.exitStopLossPct >= 100 || numeric.exitTakeProfitPct > 10_000
      || numeric.exitTrailingActivationPct > 10_000
      || numeric.exitTrailingDrawdownPct >= 100) failures.push("live-worker-exit-policy-invalid");
  return Object.freeze({ ...execution, connected, automatic, exitPathConnected,
    configured: failures.length === 0, observerUrl, observerHostname, observerBearerToken,
    statePath, evidencePath,
    routerAddress, wethAddress: ROBINHOOD.weth.toLowerCase(), chainId: ROBINHOOD.chainId,
    amountInWei, maximumAllowanceWei, minimumNativeBalanceWei, confirmation,
    expectedConfirmation, ...numeric,
    exitPolicy: Object.freeze({ stopLossPct: numeric.exitStopLossPct,
      takeProfitPct: numeric.exitTakeProfitPct,
      trailingActivationPct: numeric.exitTrailingActivationPct,
      trailingDrawdownPct: numeric.exitTrailingDrawdownPct,
      maxHoldMs: numeric.exitMaxHoldMs }),
    factories: Object.freeze(Object.fromEntries(ROBINHOOD.factories
      .filter((item) => item.version === "v2")
      .map((item) => [item.dex, item.address.toLowerCase()]))),
    factoryFeeBps: Object.freeze(Object.fromEntries(ROBINHOOD.factories
      .filter((item) => item.version === "v2")
      .map((item) => [item.address.toLowerCase(), item.dex === "pancakeswap" ? 25 : 30]))),
    riskPolicy: Object.freeze({ minPoolAgeMs: 5 * 60_000, maxPriceImpactPct: 1.5,
      maxExecutionCostPct: 4, maxSpotSwapDeviationPct: 5,
      allowedSignals: Object.freeze(["active"]), minSwaps: 4,
      minAcceleration: 0.75, maxAcceleration: 1.5 }),
    failures: Object.freeze([...new Set(failures)]) });
}
