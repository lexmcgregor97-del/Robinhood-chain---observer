import test from "node:test";
import assert from "node:assert/strict";
import { keccak256 } from "viem";
import { createEvmExecutionProvider } from "./turnkey-execution-provider.js";

const wallet = "0x1111111111111111111111111111111111111111";
const router = "0x2222222222222222222222222222222222222222";
const payload = `0x${"ab".repeat(100)}`;
const intent = { from: wallet, to: router, chainId: 4663, data: "0x12345678", valueWei: "0" };

test("builds, signs, broadcasts, and normalizes a successful receipt", async () => {
  const calls = [];
  const account = {
    address: wallet,
    async signTransaction(request) { calls.push(["sign", request]); return payload; },
  };
  let receiptCalls = 0;
  const rpc = async (method, params) => {
    calls.push([method, params]);
    if (method === "eth_getTransactionCount") return "0x7";
    if (method === "eth_estimateGas") return "0x5208";
    if (method === "eth_gasPrice") return "0x3b9aca00";
    if (method === "eth_sendRawTransaction") return keccak256(payload);
    if (method === "eth_getTransactionReceipt") {
      receiptCalls += 1;
      return receiptCalls === 1 ? null : { status: "0x1", transactionHash: keccak256(payload) };
    }
    throw new Error("unexpected-method");
  };
  const provider = createEvmExecutionProvider({ account, rpc, receiptPollMs: 100,
    receiptTimeoutMs: 1_000 });
  assert.equal(await provider.getPendingNonce(intent), 7);
  const signed = await provider.sign(intent, { nonce: 7 });
  assert.equal(signed.transactionHash, keccak256(payload));
  assert.equal(await provider.broadcast(signed.payload), keccak256(payload));
  assert.equal((await provider.waitForReceipt(signed.transactionHash)).status, "success");
  const signRequest = calls.find(([name]) => name === "sign")[1];
  assert.equal(signRequest.chainId, 4663);
  assert.equal(signRequest.nonce, 7);
  assert.equal(signRequest.gas, 21_000n);
  assert.equal(signRequest.gasPrice, 1_000_000_000n);
});

test("fails before signing for the wrong wallet or malformed provider quantities", async () => {
  let signed = false;
  const account = { address: wallet, async signTransaction() { signed = true; return payload; } };
  const provider = createEvmExecutionProvider({ account,
    rpc: async (method) => method === "eth_estimateGas" ? "garbage" : "0x1" });
  await assert.rejects(provider.sign({ ...intent, from: router }, { nonce: 0 }), /signing-wallet-mismatch/);
  await assert.rejects(provider.sign(intent, { nonce: 0 }), /invalid-gas-estimate/);
  assert.equal(signed, false);
});

test("reports mined reverts without promoting them to success", async () => {
  const provider = createEvmExecutionProvider({
    account: { address: wallet, async signTransaction() { return payload; } },
    rpc: async () => ({ status: "0x0" }),
  });
  assert.equal((await provider.getReceipt(keccak256(payload))).status, "reverted");
});
