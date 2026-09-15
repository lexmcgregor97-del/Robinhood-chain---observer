import test from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData } from "viem";
import { V2_ROUTER_ABI } from "./router-calldata.js";
import { APPROVE_ABI } from "./approval-calldata.js";
import { assessLiveApprovalPreflight, assessLiveExitPreflight } from "./live-exit-preflight.js";

const WETH = "0x0000000000000000000000000000000000000001";
const TOKEN = "0x0000000000000000000000000000000000000002";
const POOL = "0x0000000000000000000000000000000000000003";
const ROUTER = "0x0000000000000000000000000000000000000004";
const WALLET = "0x0000000000000000000000000000000000000005";
const NOW = 1_000_000;
const position = { poolAddress: POOL, baseToken: TOKEN, routerAddress: ROUTER,
  baseUnits: "100", feeBps: 30 };
const chain = { poolAddress: POOL, token0: WETH, token1: TOKEN, wethAddress: WETH,
  reserve0: "100000", reserve1: "200000", baseBalanceWei: "100",
  baseAllowanceWei: "100", nativeBalanceWei: "10", observedAt: NOW,
  blockNumber: 42, latestBlock: 42, blockTimestampMs: NOW };
const signing = { credentialVerified: true, policyVerified: true };

test("approves only a fresh, simulated, full-unit exit with exact allowance", () => {
  const data = encodeFunctionData({ abi: V2_ROUTER_ABI,
    functionName: "swapExactTokensForTokens",
    args: [100n, 1n, [TOKEN, WETH], WALLET, 2_000n] });
  const intent = { data };
  assert.equal(assessLiveExitPreflight({ intent, position, chain, signing,
    simulationPassed: true, now: NOW }).approved, true);
  const drift = assessLiveExitPreflight({ intent, position,
    chain: { ...chain, baseAllowanceWei: "101" }, signing,
    simulationPassed: true, now: NOW });
  assert.ok(drift.failures.includes("live-base-allowance-not-exact"));
});

test("approval preflight requires actual-wallet simulation and exact token balance", () => {
  const intent = { to: TOKEN, data: encodeFunctionData({ abi: APPROVE_ABI,
    functionName: "approve", args: [ROUTER, 100n] }) };
  assert.equal(assessLiveApprovalPreflight({ intent, position, chain, signing,
    simulationPassed: true, minimumNativeBalanceWei: "1", now: NOW }).approved, true);
  const failed = assessLiveApprovalPreflight({ intent, position, chain, signing,
    simulationPassed: false, minimumNativeBalanceWei: "1", now: NOW });
  assert.ok(failed.failures.includes("live-approval-simulation-failed"));
});
