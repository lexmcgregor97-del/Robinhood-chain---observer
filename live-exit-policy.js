import { isAddressEqual } from "viem";
import { quoteV2 } from "./v2-simulator.js";
import { DEFAULT_PAPER_STRATEGY } from "./paper-strategy.js";

const percentReached = (current, basis, percent, direction) => {
  const scaledCurrent = BigInt(current) * 10_000n;
  const threshold = BigInt(basis) * BigInt(Math.round(percent * 100));
  return direction === "below" ? scaledCurrent <= threshold : scaledCurrent >= threshold;
};

export const DEFAULT_LIVE_EXIT_POLICY = Object.freeze({
  stopLossPct: DEFAULT_PAPER_STRATEGY.stopLossPct,
  takeProfitPct: DEFAULT_PAPER_STRATEGY.takeProfitPct,
  trailingActivationPct: DEFAULT_PAPER_STRATEGY.trailingActivationPct,
  trailingDrawdownPct: DEFAULT_PAPER_STRATEGY.trailingDrawdownPct,
  maxHoldMs: DEFAULT_PAPER_STRATEGY.maxHoldMs,
});

export function quoteLivePositionExit(position, snapshot) {
  const baseIsToken0 = isAddressEqual(position.baseToken, snapshot.token0);
  const baseIsToken1 = isAddressEqual(position.baseToken, snapshot.token1);
  if (baseIsToken0 === baseIsToken1) throw new Error("live-position-chain-mismatch");
  const reserveIn = BigInt(baseIsToken0 ? snapshot.reserve0 : snapshot.reserve1);
  const reserveOut = BigInt(baseIsToken0 ? snapshot.reserve1 : snapshot.reserve0);
  return quoteV2({ reserveIn, reserveOut, amountIn: BigInt(position.baseUnits),
    feeBps: Number(position.feeBps) }).amountOut.toString();
}

export function liveExitReason(position, currentWethOutWei, now = Date.now(),
  policy = DEFAULT_LIVE_EXIT_POLICY) {
  if (position?.status !== "open") return null;
  let current, entry, peak;
  try {
    current = BigInt(currentWethOutWei); entry = BigInt(position.entryWethWei);
    peak = BigInt(position.peakWethOutWei);
  } catch { return null; }
  if (current <= 0n || entry <= 0n || peak <= 0n) return null;
  if (percentReached(current, entry, 100 - Number(policy.stopLossPct), "below")) {
    return "stop-loss";
  }
  if (percentReached(current, entry, 100 + Number(policy.takeProfitPct), "above")) {
    return "take-profit";
  }
  const activated = percentReached(peak, entry,
    100 + Number(policy.trailingActivationPct), "above");
  const trailed = percentReached(current, peak,
    100 - Number(policy.trailingDrawdownPct), "below");
  if (activated && trailed) return "trailing-stop";
  if (Number(now) - Number(position.openedAt) >= Number(policy.maxHoldMs)) return "max-hold";
  return null;
}
