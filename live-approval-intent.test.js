import test from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData } from "viem";
import { APPROVE_ABI } from "./approval-calldata.js";
import { buildLiveExitApprovalIntent } from "./live-approval-intent.js";

const TOKEN = "0x0000000000000000000000000000000000000002";
const ROUTER = "0x0000000000000000000000000000000000000003";
const WALLET = "0x0000000000000000000000000000000000000004";

test("approves only the receipt-derived exact position units", () => {
  const intent = buildLiveExitApprovalIntent({ position: { baseToken: TOKEN,
    routerAddress: ROUTER, baseUnits: "123", entryIntentId: "buy:1" },
  snapshot: { blockNumber: 42 },
  config: { chainId: 4663, walletAddress: WALLET, allowedRouters: [ROUTER] }, now: 1 });
  const call = decodeFunctionData({ abi: APPROVE_ABI, data: intent.data });
  assert.equal(call.args[0].toLowerCase(), ROUTER.toLowerCase());
  assert.equal(call.args[1], 123n);
  assert.equal(intent.spendAmount, "123");
});

test("builds a distinct zero-reset intent without widening declared position units", () => {
  const position = { baseToken: TOKEN, routerAddress: ROUTER,
    baseUnits: "123", entryIntentId: "buy:1" };
  const intent = buildLiveExitApprovalIntent({ position, snapshot: { blockNumber: 42 },
    amountWei: "0", config: { chainId: 4663, walletAddress: WALLET,
      allowedRouters: [ROUTER] }, now: 1 });
  const call = decodeFunctionData({ abi: APPROVE_ABI, data: intent.data });
  assert.equal(intent.purpose, "live-exit-approval-reset");
  assert.equal(intent.spendAmount, "123");
  assert.equal(call.args[1], 0n);
});
