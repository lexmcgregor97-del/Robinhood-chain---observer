import test from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { loadTurnkeyConfig, TurnkeyEvmProvider } from "./turnkey-provider.js";

const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const recipient = `0x${"22".repeat(20)}`;
const hash = `0x${"ab".repeat(32)}`;

test("Turnkey config stays dormant when absent and rejects partial setup", () => {
  assert.deepEqual(loadTurnkeyConfig({}), { enabled: false });
  assert.throws(
    () => loadTurnkeyConfig({ TURNKEY_ORGANIZATION_ID: "org" }),
    /incomplete-turnkey-config/,
  );
});

test("Turnkey config normalizes its public wallet address", () => {
  const config = loadTurnkeyConfig({
    TURNKEY_ORGANIZATION_ID: "org",
    TURNKEY_API_PUBLIC_KEY: "public",
    TURNKEY_API_PRIVATE_KEY: "private",
    TURNKEY_WALLET_ADDRESS: account.address.toUpperCase().replace("0X", "0x"),
    TURNKEY_WALLET_ID: "wallet-id",
  });
  assert.equal(config.enabled, true);
  assert.equal(config.walletAddress, account.address.toLowerCase());
  assert.equal(config.walletId, "wallet-id");
});

test("signs the exact serialized intent and verifies the returned signer", async () => {
  let submitted;
  const rpcClient = {
    async getTransactionCount() { return 4; },
    async estimateGas() { return 21_000n; },
    async estimateFeesPerGas() { return { maxFeePerGas: 10n, maxPriorityFeePerGas: 1n }; },
  };
  const apiClient = {
    async signTransaction(input) {
      submitted = input;
      const payload = await account.signTransaction({
        chainId: 4663, nonce: 4, gas: 21_000n,
        maxFeePerGas: 10n, maxPriorityFeePerGas: 1n,
        to: recipient, value: 1n, data: "0x12345678", type: "eip1559",
      });
      return { activity: { result: { signTransactionResult: { signedTransaction: payload } } } };
    },
  };
  const provider = new TurnkeyEvmProvider({
    organizationId: "org", walletAddress: account.address, apiClient, rpcClient,
  });
  const intent = {
    from: account.address.toLowerCase(), to: recipient, data: "0x12345678",
    valueWei: "1", chainId: 4663,
  };
  assert.equal(await provider.getPendingNonce(intent), 4);
  const signed = await provider.sign(intent, { nonce: 4 });
  assert.equal(submitted.organizationId, "org");
  assert.equal(submitted.signWith, account.address.toLowerCase());
  assert.equal(submitted.type, "TRANSACTION_TYPE_ETHEREUM");
  assert.match(signed.transactionHash, /^0x[0-9a-f]{64}$/);
});

test("rejects a signed transaction from any other key", async () => {
  const attacker = privateKeyToAccount(`0x${"33".repeat(32)}`);
  const payload = await attacker.signTransaction({
    chainId: 4663, nonce: 0, gas: 21_000n,
    maxFeePerGas: 10n, maxPriorityFeePerGas: 1n,
    to: recipient, value: 0n, data: "0x12345678", type: "eip1559",
  });
  const provider = new TurnkeyEvmProvider({
    organizationId: "org", walletAddress: account.address,
    apiClient: { async signTransaction() { return { activity: { result: { signTransactionResult: { signedTransaction: payload } } } }; } },
    rpcClient: {
      async estimateGas() { return 21_000n; },
      async estimateFeesPerGas() { return { maxFeePerGas: 10n, maxPriorityFeePerGas: 1n }; },
    },
  });
  await assert.rejects(provider.sign({
    from: account.address.toLowerCase(), to: recipient, data: "0x12345678",
    valueWei: "0", chainId: 4663,
  }, { nonce: 0 }), /turnkey-signature-wallet-mismatch/);
});

test("maps RPC broadcast and receipt operations onto the lifecycle interface", async () => {
  const calls = [];
  const provider = new TurnkeyEvmProvider({
    organizationId: "org", walletAddress: account.address,
    apiClient: { signTransaction() {} },
    rpcClient: {
      async sendRawTransaction({ serializedTransaction }) { calls.push(serializedTransaction); return hash; },
      async waitForTransactionReceipt({ hash: value }) { return { transactionHash: value, status: "success" }; },
      async getTransactionReceipt() { const error = new Error("missing"); error.name = "TransactionReceiptNotFoundError"; throw error; },
    },
  });
  assert.equal(await provider.broadcast("0x1234"), hash);
  assert.equal((await provider.waitForReceipt(hash)).status, "success");
  assert.equal(await provider.getReceipt(hash), null);
  assert.deepEqual(calls, ["0x1234"]);
});
