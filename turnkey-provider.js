import {
  createPublicClient,
  defineChain,
  http,
  keccak256,
  recoverTransactionAddress,
  serializeTransaction,
} from "viem";
import { Turnkey } from "@turnkey/sdk-server";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX = /^0x(?:[0-9a-fA-F]{2})+$/;

function required(value, name) {
  const result = String(value || "").trim();
  if (!result) throw new Error(`missing-turnkey-${name}`);
  return result;
}

function normalizeAddress(value, name) {
  const result = required(value, name).toLowerCase();
  if (!ADDRESS.test(result)) throw new Error(`invalid-turnkey-${name}`);
  return result;
}

export function loadTurnkeyConfig(env = process.env) {
  const keys = [
    "TURNKEY_ORGANIZATION_ID",
    "TURNKEY_API_PUBLIC_KEY",
    "TURNKEY_API_PRIVATE_KEY",
    "TURNKEY_WALLET_ADDRESS",
  ];
  const present = keys.filter((key) => String(env[key] || "").trim());
  if (present.length === 0) return Object.freeze({ enabled: false });
  if (present.length !== keys.length) {
    throw new Error(`incomplete-turnkey-config:${keys.filter((key) => !present.includes(key)).join(",")}`);
  }
  return Object.freeze({
    enabled: true,
    organizationId: required(env.TURNKEY_ORGANIZATION_ID, "organization-id"),
    apiPublicKey: required(env.TURNKEY_API_PUBLIC_KEY, "api-public-key"),
    apiPrivateKey: required(env.TURNKEY_API_PRIVATE_KEY, "api-private-key"),
    walletAddress: normalizeAddress(env.TURNKEY_WALLET_ADDRESS, "wallet-address"),
    walletId: String(env.TURNKEY_WALLET_ID || "").trim() || null,
  });
}

function signedTransactionFrom(response) {
  return response?.activity?.result?.signTransactionResult?.signedTransaction
    || response?.activity?.result?.activity?.result?.signTransactionResult?.signedTransaction;
}

export class TurnkeyEvmProvider {
  constructor({ organizationId, walletAddress, apiClient, rpcClient }) {
    this.organizationId = required(organizationId, "organization-id");
    this.walletAddress = normalizeAddress(walletAddress, "wallet-address");
    if (!apiClient?.signTransaction || !rpcClient) throw new Error("invalid-turnkey-provider-clients");
    this.apiClient = apiClient;
    this.rpcClient = rpcClient;
  }

  async getPendingNonce(intent) {
    if (intent.from !== this.walletAddress) throw new Error("turnkey-wallet-mismatch");
    return this.rpcClient.getTransactionCount({ address: this.walletAddress, blockTag: "pending" });
  }

  async sign(intent, { nonce }) {
    if (intent.from !== this.walletAddress) throw new Error("turnkey-wallet-mismatch");
    const request = {
      account: this.walletAddress,
      to: intent.to,
      data: intent.data,
      value: BigInt(intent.valueWei),
    };
    const [gas, fees] = await Promise.all([
      this.rpcClient.estimateGas(request),
      this.rpcClient.estimateFeesPerGas(),
    ]);
    const unsignedTransaction = serializeTransaction({
      chainId: intent.chainId,
      nonce,
      gas,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      to: intent.to,
      value: BigInt(intent.valueWei),
      data: intent.data,
      type: "eip1559",
    });
    const response = await this.apiClient.signTransaction({
      organizationId: this.organizationId,
      signWith: this.walletAddress,
      unsignedTransaction,
      type: "TRANSACTION_TYPE_ETHEREUM",
    });
    const payload = signedTransactionFrom(response);
    if (!HEX.test(String(payload || ""))) throw new Error("turnkey-signed-transaction-missing");
    const signer = (await recoverTransactionAddress({ serializedTransaction: payload })).toLowerCase();
    if (signer !== this.walletAddress) throw new Error("turnkey-signature-wallet-mismatch");
    return Object.freeze({ payload, transactionHash: keccak256(payload) });
  }

  async broadcast(payload) {
    return this.rpcClient.sendRawTransaction({ serializedTransaction: payload });
  }

  async waitForReceipt(transactionHash) {
    return this.rpcClient.waitForTransactionReceipt({ hash: transactionHash });
  }

  async getReceipt(transactionHash) {
    try {
      return await this.rpcClient.getTransactionReceipt({ hash: transactionHash });
    } catch (error) {
      if (error?.name === "TransactionReceiptNotFoundError") return null;
      throw error;
    }
  }
}

export function createTurnkeyEvmProvider({ config, chainId, rpcUrl }) {
  if (!config?.enabled) throw new Error("turnkey-not-configured");
  const turnkey = new Turnkey({
    apiBaseUrl: "https://api.turnkey.com",
    apiPublicKey: config.apiPublicKey,
    apiPrivateKey: config.apiPrivateKey,
    defaultOrganizationId: config.organizationId,
  });
  const chain = defineChain({
    id: chainId,
    name: `EVM ${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  return new TurnkeyEvmProvider({
    organizationId: config.organizationId,
    walletAddress: config.walletAddress,
    apiClient: turnkey.apiClient(),
    rpcClient: createPublicClient({ chain, transport: http(rpcUrl) }),
  });
}
