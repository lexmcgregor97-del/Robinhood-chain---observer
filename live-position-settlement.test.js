import test from "node:test";
import assert from "node:assert/strict";
import { encodeEventTopics, encodeAbiParameters, encodeFunctionData,
  serializeTransaction } from "viem";
import { V2_ROUTER_ABI } from "./router-calldata.js";
import { settlementFromExecutionRecord, TRANSFER_ABI } from "./live-position-settlement.js";

const WETH = "0x0000000000000000000000000000000000000001";
const TOKEN = "0x0000000000000000000000000000000000000002";
const ROUTER = "0x0000000000000000000000000000000000000003";
const WALLET = "0x0000000000000000000000000000000000000004";
const POOL = "0x0000000000000000000000000000000000000005";
const signature = { r: `0x${"1".repeat(64)}`, s: `0x${"2".repeat(64)}`, yParity: 0 };

function record(path, receivedToken, amount) {
  const data = encodeFunctionData({ abi: V2_ROUTER_ABI,
    functionName: "swapExactTokensForTokens",
    args: [10n, 1n, path, WALLET, 100n] });
  const signedPayload = serializeTransaction({ type: "eip1559", chainId: 4663,
    nonce: 1, to: ROUTER, data, value: 0n, gas: 100000n,
    maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }, signature);
  return { status: "confirmed", signedPayload, transactionHash: `0x${"3".repeat(64)}`,
    receipt: { blockNumber: "0x2a", logs: [{ address: receivedToken,
      topics: encodeEventTopics({ abi: TRANSFER_ABI, eventName: "Transfer",
        args: { from: POOL, to: WALLET } }),
      data: encodeAbiParameters([{ type: "uint256" }], [amount]) }] } };
}

test("derives exact buy fill and sell proceeds only from durable receipt transfers", () => {
  const buy = settlementFromExecutionRecord(record([WETH, TOKEN], TOKEN, 123n),
    { walletAddress: WALLET, wethAddress: WETH });
  assert.deepEqual({ side: buy.side, baseToken: buy.baseToken,
    receivedUnits: buy.receivedUnits }, { side: "buy", baseToken: TOKEN.toLowerCase(),
    receivedUnits: "123" });
  const sell = settlementFromExecutionRecord(record([TOKEN, WETH], WETH, 9n),
    { walletAddress: WALLET, wethAddress: WETH });
  assert.equal(sell.side, "sell");
  assert.equal(sell.receivedUnits, "9");
});
