import { Turnkey } from "@turnkey/sdk-server";
import { ExecutionLifecycle } from "./execution-lifecycle.js";
import { validateV2RouterCalldata } from "./router-calldata.js";
import { RpcTransport, rpcUrlsFromEnv } from "./rpc-transport.js";
import { ROBINHOOD } from "./chain-config.js";
import { createTurnkeySigningAccount, createEvmExecutionProvider }
  from "./turnkey-execution-provider.js";
import { createLiveCandidateInspector } from "./live-chain-inspector.js";
import { createLiveExecutionPreflight } from "./live-execution-preflight.js";
import { openLiveExecutionStore } from "./live-execution-store.js";
import { createObserverCandidateSource, LiveExecutionWorker } from "./live-execution-worker.js";
import { assessIndependentV2Strategy } from "./live-v2-strategy.js";
import { createLiveSellProbeAdapter, createObserverReadinessAdapter,
  createSigningPolicyAdapter } from "./live-worker-adapters.js";
import { liveWorkerConfigFromEnv } from "./live-worker-config.js";
import { executionRecoveryLockPresent } from "./execution-recovery-lock.js";

const SWAP_EXACT_TOKENS_FOR_TOKENS = "0x38ed1739";

export async function createLiveWorkerRuntime({ env = process.env, fetchImpl = fetch,
  now = Date.now, makeTurnkeyClient, makeSigningAccount, openStore = openLiveExecutionStore,
  lockPresent = executionRecoveryLockPresent,
} = {}) {
  const config = liveWorkerConfigFromEnv(env);
  if (!config.configured) throw new Error(`live-worker-config-invalid:${config.failures.join(",")}`);
  if (!config.connected || !config.automatic) return Object.freeze({ connected: false,
    automatic: false, config, async runOnce() {
      return Object.freeze({ status: "disabled", reason: "live-worker-not-armed" });
    } });
  const signingPrivateKey = String(env.TURNKEY_SIGNING_API_PRIVATE_KEY || "");
  if (!signingPrivateKey) throw new Error("live-worker-signing-private-key-required");
  const transport = new RpcTransport({ urls: rpcUrlsFromEnv({ primary: env.RPC_URL,
    fallbacks: env.RPC_FALLBACK_URLS, defaultUrl: ROBINHOOD.rpcUrl }), fetchImpl });
  const rpc = (method, params) => transport.request(method, params);
  const chainId = Number(BigInt(await rpc("eth_chainId", [])));
  if (chainId !== config.chainId) throw new Error("live-worker-chain-mismatch");
  if (await lockPresent(config.statePath)) throw new Error("execution-recovery-lock-present");
  const store = await openStore({ statePath: config.statePath,
    evidencePath: config.evidencePath, now });
  const clientFactory = makeTurnkeyClient || ((input) => new Turnkey({
    apiBaseUrl: "https://api.turnkey.com", defaultOrganizationId: input.organizationId,
    apiPublicKey: input.apiPublicKey, apiPrivateKey: input.apiPrivateKey }).apiClient());
  const signingClient = clientFactory({ organizationId: config.organizationId,
    apiPublicKey: config.apiPublicKey, apiPrivateKey: signingPrivateKey });
  const signingCheck = createSigningPolicyAdapter({ config, client: signingClient });
  const initialSigning = await signingCheck();
  if (!initialSigning.credentialVerified || !initialSigning.policyVerified) {
    throw new Error("live-worker-signing-boundary-not-verified");
  }
  const accountFactory = makeSigningAccount || createTurnkeySigningAccount;
  const account = await accountFactory(config, signingPrivateKey);
  const provider = createEvmExecutionProvider({ account, rpc, maxGas: config.maxGas,
    maxFeePerGasWei: config.maxFeePerGasWei });
  const plans = new Map();
  const readinessCheck = createObserverReadinessAdapter({ url: config.observerUrl,
    expectedHostname: config.observerHostname,
    bearerToken: config.observerBearerToken, fetchImpl });
  const sellCheck = createLiveSellProbeAdapter({ rpc, config });
  const strategyCheck = (input) => assessIndependentV2Strategy({ ...input, rpc, config });
  const inspector = createLiveCandidateInspector({ config, rpc,
    assessStrategy: strategyCheck, assessReadiness: readinessCheck,
    verifySigning: signingCheck, probeSell: sellCheck,
    minimumNativeBalanceWei: config.minimumNativeBalanceWei,
    maximumAllowanceWei: config.maximumAllowanceWei });
  const preflight = createLiveExecutionPreflight({ plans,
    inspect: (intent, plan, context) => inspector({ version: "v2", dex: plan.dex,
      address: plan.poolAddress, token0: plan.token0, token1: plan.token1,
      discoveryBlock: plan.discoveryBlock }, { phase: "preflight", intent, plan, ...context }) });
  const policy = Object.freeze({ allowedChainIds: [config.chainId],
    walletAddress: config.walletAddress, maxExpiryMs: 60_000, maxValueWei: "0",
    allowedCalls: { [config.routerAddress]: [SWAP_EXACT_TOKENS_FOR_TOKENS] },
    spendLimits: { [config.wethAddress]: { maxPerTransaction: config.maxPerTransactionWei,
      maxDaily: config.maxDailyWei } }, maxRouterDeadlineSeconds: 60 });
  const validateCalldata = (intent, basePolicy, context) => {
    const plan = plans.get(intent.id);
    if (!plan) return { approved: false, failures: ["live-intent-plan-missing"], call: null };
    return validateV2RouterCalldata(intent, { ...basePolicy,
      allowedPaths: [[config.wethAddress, plan.baseToken]] }, context);
  };
  const lifecycle = new ExecutionLifecycle({ policy, ledger: store.spendLedger,
    journal: store.journal, nonceLane: store.nonceLane, provider, preflight, validateCalldata });
  await lifecycle.recoverPending({ now: Number(now()) });
  const worker = new LiveExecutionWorker({
    source: createObserverCandidateSource({ url: config.observerUrl,
      expectedHostname: config.observerHostname,
      bearerToken: config.observerBearerToken, fetchImpl }),
    inspectCandidate: inspector, lifecycle, journal: store.journal, plans, config });
  return Object.freeze({ connected: true, automatic: true, config, store, lifecycle,
    transport, async runOnce(options) {
      if (await lockPresent(config.statePath)) throw new Error("execution-recovery-lock-present");
      return worker.runOnce(options);
    } });
}
