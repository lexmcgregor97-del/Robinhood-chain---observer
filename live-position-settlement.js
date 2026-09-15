import { decodeEventLog, decodeFunctionData, parseTransaction } from "viem";
import { V2_ROUTER_ABI } from "./router-calldata.js";

const TRANSFER_ABI = Object.freeze([{ type: "event", name: "Transfer", inputs: [
  { indexed: true, name: "from", type: "address" },
  { indexed: true, name: "to", type: "address" },
  { indexed: false, name: "value", type: "uint256" },
] }]);

function receivedUnits(receipt, token, wallet) {
  let total = 0n;
  const sources = new Set();
  for (const log of receipt?.logs || []) {
    if (String(log?.address || "").toLowerCase() !== String(token).toLowerCase()) continue;
    try {
      const event = decodeEventLog({ abi: TRANSFER_ABI, data: log.data, topics: log.topics });
      if (event.eventName === "Transfer"
          && String(event.args.to).toLowerCase() === String(wallet).toLowerCase()) {
        total += BigInt(event.args.value);
        sources.add(String(event.args.from).toLowerCase());
      }
    } catch {}
  }
  if (total <= 0n) throw new Error("live-settlement-received-units-missing");
  if (sources.size !== 1) throw new Error("live-settlement-transfer-source-ambiguous");
  return { units: total.toString(), source: [...sources][0] };
}

export function settlementFromExecutionRecord(record, { walletAddress, wethAddress } = {}) {
  if (record?.status !== "confirmed" || !record.signedPayload || !record.receipt) {
    throw new Error("live-settlement-confirmed-record-required");
  }
  const transaction = parseTransaction(record.signedPayload);
  const call = decodeFunctionData({ abi: V2_ROUTER_ABI, data: transaction.data });
  if (call.functionName !== "swapExactTokensForTokens") {
    throw new Error("live-settlement-swap-required");
  }
  const [amountIn, , path, recipient] = call.args;
  if (String(recipient).toLowerCase() !== String(walletAddress).toLowerCase()
      || path.length !== 2) throw new Error("live-settlement-path-invalid");
  const buy = String(path[0]).toLowerCase() === String(wethAddress).toLowerCase();
  const sell = String(path[1]).toLowerCase() === String(wethAddress).toLowerCase();
  if (buy === sell) throw new Error("live-settlement-path-invalid");
  const receivedToken = path[1];
  const received = receivedUnits(record.receipt, receivedToken, walletAddress);
  return Object.freeze({ side: buy ? "buy" : "sell", amountIn: BigInt(amountIn).toString(),
    baseToken: String(buy ? path[1] : path[0]).toLowerCase(),
    receivedUnits: received.units, transferSource: received.source,
    routerAddress: String(transaction.to).toLowerCase(),
    transactionHash: record.transactionHash, blockNumber: record.receipt.blockNumber });
}

export { TRANSFER_ABI };
