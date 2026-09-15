import { Turnkey } from "@turnkey/sdk-server";
import { createAccount } from "@turnkey/viem";
import { getAddress, isAddressEqual, keccak256 } from "viem";

const HEX_QUANTITY = /^0x[0-9a-fA-F]+$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

const asQuantity = (value, name) => {
  const text = String(value || "");
  if (!HEX_QUANTITY.test(text)) throw new Error(`invalid-${name}`);
  return BigInt(text);
};

const normalizedReceipt = (receipt) => {
  if (!receipt) return null;
  return {
    ...receipt,
    status: receipt.status === "0x1" || receipt.status === 1 ? "success" : "reverted",
  };
};

export async function createTurnkeySigningAccount(config, apiPrivateKey) {
  if (!config?.configured) throw new Error("micro-mainnet-config-incomplete");
  if (!apiPrivateKey) throw new Error("turnkey-signing-private-key-required");
  const client = new Turnkey({
    apiBaseUrl: "https://api.turnkey.com",
    defaultOrganizationId: config.organizationId,
    apiPublicKey: config.apiPublicKey,
    apiPrivateKey,
  }).apiClient();
  const account = await createAccount({
    client,
    organizationId: config.organizationId,
    signWith: config.walletAddress,
    ethereumAddress: config.walletAddress,
  });
  if (!isAddressEqual(account.address, config.walletAddress)) {
    throw new Error("signing-wallet-address-mismatch");
  }
  return account;
}

export function createEvmExecutionProvider({
  account,
  rpc,
  maxGas,
  maxFeePerGasWei,
  receiptPollMs = 2_000,
  receiptTimeoutMs = 120_000,
} = {}) {
  if (!account || typeof account.signTransaction !== "function" || typeof rpc !== "function") {
    throw new Error("invalid-turnkey-execution-provider");
  }
  const gasLimit = BigInt(String(maxGas || "0"));
  const feeLimit = BigInt(String(maxFeePerGasWei || "0"));
  if (gasLimit <= 0n || feeLimit <= 0n) throw new Error("execution-gas-limits-required");
  if (!Number.isFinite(receiptPollMs) || receiptPollMs < 100
      || !Number.isFinite(receiptTimeoutMs) || receiptTimeoutMs < receiptPollMs) {
    throw new Error("invalid-receipt-wait-policy");
  }

  const getReceipt = async (transactionHash) => normalizedReceipt(
    await rpc("eth_getTransactionReceipt", [transactionHash]),
  );

  return Object.freeze({
    async getPendingNonce(intent) {
      if (!isAddressEqual(intent.from, account.address)) throw new Error("signing-wallet-mismatch");
      return Number(asQuantity(await rpc("eth_getTransactionCount", [intent.from, "pending"]), "nonce"));
    },

    async sign(intent, { nonce }) {
      if (!isAddressEqual(intent.from, account.address)) throw new Error("signing-wallet-mismatch");
      const request = {
        account: account.address,
        chainId: intent.chainId,
        type: "eip1559",
        to: getAddress(intent.to),
        data: intent.data,
        value: BigInt(intent.valueWei),
        nonce,
      };
      const [gasValue, priorityValue, latestBlock] = await Promise.all([
        rpc("eth_estimateGas", [{
          from: intent.from, to: intent.to, data: intent.data,
          value: `0x${BigInt(intent.valueWei).toString(16)}`,
        }]),
        rpc("eth_maxPriorityFeePerGas", []),
        rpc("eth_getBlockByNumber", ["latest", false]),
      ]);
      const gas = asQuantity(gasValue, "gas-estimate");
      const maxPriorityFeePerGas = asQuantity(priorityValue, "priority-fee");
      const baseFeePerGas = asQuantity(latestBlock?.baseFeePerGas, "base-fee");
      const maxFeePerGas = baseFeePerGas * 2n + maxPriorityFeePerGas;
      if (gas > gasLimit) throw new Error("gas-estimate-limit");
      if (maxFeePerGas > feeLimit || maxPriorityFeePerGas > feeLimit) {
        throw new Error("gas-fee-limit");
      }
      const payload = await account.signTransaction({
        ...request,
        gas,
        maxFeePerGas,
        maxPriorityFeePerGas,
      });
      if (typeof payload !== "string" || !/^0x[0-9a-fA-F]+$/.test(payload)) {
        throw new Error("invalid-signed-transaction");
      }
      return Object.freeze({ payload, transactionHash: keccak256(payload),
        gas: gas.toString(), maxFeePerGas: maxFeePerGas.toString(),
        maxPriorityFeePerGas: maxPriorityFeePerGas.toString() });
    },

    async broadcast(payload) {
      const transactionHash = String(await rpc("eth_sendRawTransaction", [payload])).toLowerCase();
      if (!TX_HASH.test(transactionHash)) throw new Error("invalid-broadcast-transaction-hash");
      return transactionHash;
    },

    async getReceipt(transactionHash) {
      if (!TX_HASH.test(transactionHash)) throw new Error("invalid-transaction-hash");
      return getReceipt(transactionHash);
    },

    async waitForReceipt(transactionHash) {
      if (!TX_HASH.test(transactionHash)) throw new Error("invalid-transaction-hash");
      const deadline = Date.now() + receiptTimeoutMs;
      while (Date.now() < deadline) {
        const receipt = await getReceipt(transactionHash);
        if (receipt) return receipt;
        await new Promise((resolve) => setTimeout(resolve, receiptPollMs));
      }
      throw new Error("transaction-receipt-timeout");
    },
  });
}
