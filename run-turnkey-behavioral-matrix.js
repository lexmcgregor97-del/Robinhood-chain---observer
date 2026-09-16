import { chmod, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Turnkey } from "@turnkey/sdk-server";
import { encodeFunctionData, serializeTransaction } from "viem";
import { APPROVE_ABI, MAX_UINT256 } from "./approval-calldata.js";
import { ROBINHOOD } from "./chain-config.js";
import { microMainnetConfigFromEnv } from "./micro-mainnet-config.js";
import { V2_ROUTER_ABI } from "./router-calldata.js";
import { verifyTurnkeyActivityMatrix } from "./turnkey-activity-matrix.js";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const CONFIRMATION = "RUN_ATLAS_TURNKEY_MATRIX_NO_BROADCAST";
// Highest nonce viem can parse without losing integer precision. It is still
// operationally unreachable, while remaining independently verifiable.
const UNREACHABLE_NONCE = BigInt(Number.MAX_SAFE_INTEGER);
const foreign = "0x000000000000000000000000000000000000dEaD";
const other = "0x000000000000000000000000000000000000bEEF";
const SIGN_TRANSACTION = "ACTIVITY_TYPE_SIGN_TRANSACTION_V2";
const DENIED_STATUSES = new Set(["ACTIVITY_STATUS_FAILED", "ACTIVITY_STATUS_REJECTED"]);

const normalizedTransaction = (value) => String(value || "").replace(/^0x/i, "").toLowerCase();
const sameAddress = (left, right) => String(left || "").toLowerCase()
  === String(right || "").toLowerCase();

export async function recoverExpectedDenialActivity(client, config, entry,
  requestedAt = Date.now(), { attempts = 5, wait = (ms) => new Promise((resolve) =>
    setTimeout(resolve, ms)) } = {}) {
  if (typeof client?.getActivities !== "function") {
    throw new Error("turnkey-matrix-denial-list-activities-required");
  }
  const expectedTransaction = normalizedTransaction(entry?.unsignedTransaction);
  const expectedSigner = config.walletSignWith || config.walletAddress;
  const lowerBoundSeconds = Math.floor(Number(requestedAt) / 1000);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await client.getActivities({
      organizationId: config.organizationId,
      filterByType: [SIGN_TRANSACTION],
      filterByStatus: [...DENIED_STATUSES],
      paginationOptions: { limit: "100" },
    });
    const matches = (response?.activities || []).filter((activity) => {
      const intent = activity?.intent?.signTransactionIntentV2;
      return activity?.organizationId === config.organizationId
        && activity?.type === SIGN_TRANSACTION
        && DENIED_STATUSES.has(activity?.status)
        && Number(activity?.createdAt?.seconds) >= lowerBoundSeconds
        && sameAddress(intent?.signWith, expectedSigner)
        && normalizedTransaction(intent?.unsignedTransaction) === expectedTransaction;
    });
    if (matches.length === 1 && matches[0]?.id) return matches[0].id;
    if (matches.length > 1) throw new Error("turnkey-matrix-denial-activity-ambiguous");
    if (attempt + 1 < attempts) await wait(250 * (attempt + 1));
  }
  throw new Error("turnkey-matrix-denial-activity-not-found");
}

function transaction(config, overrides = {}) {
  return {
    // Matrix allows create genuine signatures. This unreachable nonce makes
    // every resulting payload permanently non-executable for this wallet; swap
    // calldata below also carries an already-expired deadline.
    type: "eip1559", chainId: ROBINHOOD.chainId, nonce: UNREACHABLE_NONCE,
    gas: BigInt(config.maxGas), maxFeePerGas: BigInt(config.maxFeePerGasWei),
    maxPriorityFeePerGas: BigInt(config.maxFeePerGasWei), value: 0n,
    ...overrides,
  };
}

function swapData({ amountIn = 1n, amountOutMin = 1n, path, recipient, selector = null }) {
  const data = encodeFunctionData({ abi: V2_ROUTER_ABI,
    functionName: "swapExactTokensForTokens",
    args: [amountIn, amountOutMin, path, recipient, 1n] });
  return selector ? `${selector}${data.slice(10)}` : data;
}

function approvalData(spender, amount) {
  return encodeFunctionData({ abi: APPROVE_ABI, functionName: "approve",
    args: [spender, amount] });
}

export function buildTurnkeyBehavioralCases(config, tokenAddress) {
  if (!ADDRESS.test(tokenAddress) || tokenAddress.toLowerCase() === ROBINHOOD.weth.toLowerCase()) {
    throw new Error("turnkey-matrix-token-invalid");
  }
  const router = config.allowedRouters[0];
  const wallet = config.walletAddress;
  const buy = (overrides = {}, call = {}) => serializeTransaction(transaction(config, {
    to: router, data: swapData({ amountIn: 1n, amountOutMin: 1n,
      path: [ROBINHOOD.weth, tokenAddress], recipient: wallet, ...call }), ...overrides,
  }));
  const approval = (spender, amount, overrides = {}) => serializeTransaction(transaction(config, {
    to: tokenAddress, data: approvalData(spender, amount), ...overrides,
  }));
  return {
    allows: [
      { case: "buy", unsignedTransaction: buy() },
      { case: "sell", unsignedTransaction: buy({}, { path: [tokenAddress, ROBINHOOD.weth] }) },
      { case: "approval", token: tokenAddress, amount: "1",
        unsignedTransaction: approval(router, 1n) },
      { case: "approval-reset", token: tokenAddress, amount: "0",
        unsignedTransaction: approval(router, 0n) },
    ],
    denials: [
      { case: "wrong-chain", unsignedTransaction: buy({ chainId: 1 }) },
      { case: "non-zero-value", unsignedTransaction: buy({ value: 1n }) },
      { case: "foreign-router", unsignedTransaction: buy({ to: foreign }) },
      { case: "wrong-selector", unsignedTransaction: buy({}, { selector: "0x00000000" }) },
      { case: "excessive-input", unsignedTransaction: buy({},
        { amountIn: BigInt(config.maxPerTransactionWei) + 1n }) },
      { case: "zero-minimum-output", unsignedTransaction: buy({}, { amountOutMin: 0n }) },
      { case: "three-token-path", unsignedTransaction: buy({},
        { path: [ROBINHOOD.weth, other, tokenAddress] }) },
      { case: "wrong-weth-orientation", unsignedTransaction: buy({},
        { path: [other, tokenAddress] }) },
      { case: "foreign-recipient", unsignedTransaction: buy({}, { recipient: foreign }) },
      { case: "excessive-gas-or-fee", unsignedTransaction: buy({
        gas: BigInt(config.maxGas) + 1n,
      }) },
      { case: "excessive-fee", unsignedTransaction: buy({
        maxFeePerGas: BigInt(config.maxFeePerGasWei) + 1n,
      }) },
      { case: "foreign-approval-spender", unsignedTransaction: approval(foreign, 1n) },
      { case: "approve-max-uint", unsignedTransaction: approval(router, MAX_UINT256) },
    ],
  };
}

export async function submitActivity(client, config, entry, expectCompleted) {
  const requestedAt = Date.now();
  let response;
  try {
    response = await client.signTransaction({
      organizationId: config.organizationId,
      signWith: config.walletSignWith || config.walletAddress,
      type: "TRANSACTION_TYPE_ETHEREUM",
      unsignedTransaction: entry.unsignedTransaction.replace(/^0x/, ""),
    });
  } catch (error) {
    if (expectCompleted) throw error;
    if (error?.activityId) return error.activityId;
    return recoverExpectedDenialActivity(client, config, entry, requestedAt);
  }
  const activityId = response?.activity?.id ?? response?.activityId ?? response?.id;
  if (!activityId) throw new Error("turnkey-matrix-activity-id-missing");
  if (!expectCompleted) {
    throw new Error(`turnkey-matrix-denial-unexpectedly-completed:${
      entry?.case || "unknown"}:${activityId}`);
  }
  return activityId;
}

export async function runTurnkeyBehavioralMatrix(env = process.env, {
  makeClient, writeMatrix = writeFile,
} = {}) {
  if (env.TURNKEY_MATRIX_CONFIRMATION !== CONFIRMATION) {
    throw new Error("turnkey-matrix-confirmation-required");
  }
  if (String(env.LIVE_WORKER_SUBMISSION_CONNECTED || "").toLowerCase() === "true"
      || String(env.LIVE_WORKER_AUTOMATIC_SUBMISSION_ENABLED || "").toLowerCase() === "true") {
    throw new Error("turnkey-matrix-live-flags-forbidden");
  }
  const config = microMainnetConfigFromEnv(env);
  if (!config.requested || !config.configured) throw new Error("turnkey-matrix-config-invalid");
  const privateKey = String(env.TURNKEY_SIGNING_VERIFY_API_PRIVATE_KEY || "");
  const output = String(env.TURNKEY_SIGNING_BEHAVIORAL_MATRIX_FILE || "");
  if (!privateKey || !output) throw new Error("turnkey-matrix-private-config-required");
  const token = String(env.TURNKEY_MATRIX_TOKEN_ADDRESS || "");
  const client = makeClient ? makeClient(config, privateKey) : new Turnkey({
    apiBaseUrl: "https://api.turnkey.com", defaultOrganizationId: config.organizationId,
    apiPublicKey: config.apiPublicKey, apiPrivateKey: privateKey,
  }).apiClient();
  const cases = buildTurnkeyBehavioralCases(config, token);
  const matrix = { runAt: Date.now(), allows: [], denials: [] };
  for (const entry of cases.allows) {
    const activityId = await submitActivity(client, config, entry, true);
    matrix.allows.push({ case: entry.case, activityId,
      ...(entry.token ? { token: entry.token, amount: entry.amount } : {}) });
  }
  for (const entry of cases.denials) {
    matrix.denials.push({ case: entry.case,
      activityId: await submitActivity(client, config, entry, false) });
  }
  const verified = await verifyTurnkeyActivityMatrix({ matrix, config,
    signingUserId: String((await client.getWhoami({ organizationId: config.organizationId })).userId),
    getActivity: (request) => client.getActivity(request) });
  if (!verified.verified) throw new Error(`turnkey-matrix-verification-failed:${verified.failures.join(",")}`);
  await writeMatrix(output, `${JSON.stringify(matrix, null, 2)}\n`, { mode: 0o600 });
  await chmod(output, 0o600);
  return { verified: true, runAt: matrix.runAt,
    allowCount: matrix.allows.length, denialCount: matrix.denials.length,
    activityIds: [...matrix.allows, ...matrix.denials].map((entry) => entry.activityId),
    broadcastCount: 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${JSON.stringify(await runTurnkeyBehavioralMatrix(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
