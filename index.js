import http from "node:http";
import { createReadStream } from "node:fs";
import { dirname, join } from "node:path";
import { rankPools } from "./signals.js";
import { decodeSwapEvent } from "./market-data.js";
import { DEFAULT_PAPER_POLICY, evaluateRiskGate } from "./risk-gate.js";
import { PaperPortfolio } from "./paper-portfolio.js";
import {
  DEFAULT_PAPER_STRATEGY, planPaperEntry, paperExitReason, paperCircuitFailures,
} from "./paper-strategy.js";
import { analyzePaperTrades } from "./paper-analytics.js";
import { ShadowEvaluator } from "./shadow-evaluator.js";
import { PassiveDislocationObserver } from "./passive-dislocation-observer.js";
import { auditSwapPrice } from "./price-audit.js";
import { ROBINHOOD } from "./chain-config.js";
import { decodeV2Reserves, evaluateV2MarketSafety, evaluateV3MarketSafety } from "./market-safety.js";
import { decodeUint, decodeV3Slot0, quoteV3WithinTick } from "./v3-simulator.js";
import { quoteV2 } from "./v2-simulator.js";
import {
  bitmapPosition, compressTick, encodeInt16Call, findInitializedTickInWord,
  staysWithinTickBoundary,
} from "./tick-boundary.js";
import { loadJsonState, saveJsonState } from "./state-store.js";
import { assessReadiness } from "./readiness.js";
import { isRpcThrottleError, nextBackoffMs, RpcScheduler } from "./rpc-scheduler.js";
import { createTokenMetadataLoader } from "./token-metadata.js";
import { LogDeduplicator } from "./log-deduplicator.js";
import { PositionLiveness } from "./position-liveness.js";
import { RpcTransport, rpcUrlsFromEnv } from "./rpc-transport.js";
import { fetchLogsAdaptive } from "./rpc-log-query.js";
import { envFlag } from "./runtime-flags.js";
import { assessLiveReadiness } from "./live-readiness.js";
import {
  probeTurnkeyPolicy, probeTurnkeyWallet, turnkeyConfigFromEnv,
} from "./turnkey-probe.js";
import { Turnkey } from "@turnkey/sdk-server";
import { EvidenceJournal } from "./evidence-journal.js";
import { validateEvidenceCheckpoint } from "./evidence-checkpoint.js";
import { gasMeasurementFromEnv, verifyGasMeasurement } from "./gas-measurement.js";
import {
  probeStateOverrideSupport, probeV2Sell, sellProbeConfigFromEnv,
} from "./v2-sell-probe.js";
import { planLosslessRecovery, recoveryPaperCycleMode } from "./recovery-policy.js";
import {
  assessMicroMainnetActivation, forbiddenRuntimeSecretFailures,
  microMainnetConfigFromEnv, publicMicroMainnetConfig,
} from "./micro-mainnet-config.js";
import { assessTurnkeySigningPolicy } from "./turnkey-signing-probe.js";
import { readSigningAttestation, verifySigningAttestation } from "./signing-attestation.js";
import { ExecutionJournal } from "./execution-journal.js";
import { NonceLane } from "./nonce-lane.js";
import { DailySpendLedger } from "./spend-ledger.js";
import {
  executionPendingCount, validateExecutionCheckpoint,
} from "./execution-checkpoint.js";
import { createExecutionMutationSerializer } from "./execution-mutation-queue.js";
import { executionRecoveryLockPresent } from "./execution-recovery-lock.js";
import { finalizeExecutionNonceResidue } from "./execution-recovery.js";
import { workerObserverAuthorized } from "./worker-observer-auth.js";

const FORBIDDEN_RUNTIME_SECRETS = forbiddenRuntimeSecretFailures(process.env);
if (FORBIDDEN_RUNTIME_SECRETS.length) throw new Error(FORBIDDEN_RUNTIME_SECRETS.join(","));

const PORT = Number(process.env.PORT || 3000);
const RPC_URLS = rpcUrlsFromEnv({
  primary: process.env.RPC_URL,
  fallbacks: process.env.RPC_FALLBACK_URLS,
  defaultUrl: ROBINHOOD.rpcUrl,
});
const CHAIN_ID = ROBINHOOD.chainId;
const LIVE_WORKER_OBSERVER_BEARER_TOKEN = String(
  process.env.LIVE_WORKER_OBSERVER_BEARER_TOKEN || "",
);
const POLL_MS = Number(process.env.POLL_INTERVAL_MS || 30_000);
const RPC_MIN_INTERVAL_MS = Number(process.env.RPC_MIN_INTERVAL_MS || 250);
const RPC_JITTER_MS = Number(process.env.RPC_JITTER_MS || 50);
const BACKFILL = 20_000;
const CHUNK = 500;
const MAX_RECOVERY_BLOCKS_PER_POLL = 100;
const MAX_POOLS = 5_000;
const SIGNAL_WINDOW_MS = Number(process.env.SIGNAL_WINDOW_MS || 60_000);
const SIGNAL_BASELINE_MS = Number(process.env.SIGNAL_BASELINE_MS || 300_000);
const SIGNAL_HISTORY_MS = Math.max(
  SIGNAL_WINDOW_MS + SIGNAL_BASELINE_MS,
  Number(process.env.SIGNAL_HISTORY_MS || 10 * 60_000),
);
const SIGNAL_MIN_SWAPS = Number(process.env.SIGNAL_MIN_SWAPS || 3);
const PAPER_INITIAL_CASH = Number(process.env.PAPER_INITIAL_CASH || 1000);
const PAPER_MAX_POSITIONS = Number(process.env.PAPER_MAX_POSITIONS || 3);
const PAPER_WETH_INITIAL_CASH = Number(process.env.PAPER_WETH_INITIAL_CASH || 0.1);
const PAPER_WETH_MAX_ENTRY = Number(process.env.PAPER_WETH_MAX_ENTRY || 0.01);
const PAPER_USDG_MAX_ENTRY = Number(process.env.PAPER_USDG_MAX_ENTRY || 100);
const PAPER_WETH_GAS_PER_SIDE = Number(process.env.PAPER_WETH_GAS_PER_SIDE || 0.00001);
const PAPER_USDG_GAS_PER_SIDE = Number(process.env.PAPER_USDG_GAS_PER_SIDE || 0.03);
const PAPER_CYCLE_MS = Number(process.env.PAPER_CYCLE_MS || 10_000);
const CONFIGURED_GAS_VERIFICATION_INTERVAL_MS = Number(
  process.env.GAS_VERIFICATION_INTERVAL_MS || 60 * 60_000,
);
const GAS_VERIFICATION_INTERVAL_MS = Number.isFinite(CONFIGURED_GAS_VERIFICATION_INTERVAL_MS)
  && CONFIGURED_GAS_VERIFICATION_INTERVAL_MS >= 60_000
  ? CONFIGURED_GAS_VERIFICATION_INTERVAL_MS : 60 * 60_000;
const STATE_FILE = String(process.env.STATE_FILE || "");
const STATE_SAVE_MS = Number(process.env.STATE_SAVE_MS || 30_000);
const V3_BOUNDARY_CACHE_MS = Number(process.env.V3_BOUNDARY_CACHE_MS || 30_000);
const CANDIDATE_CACHE_MS = Number(process.env.CANDIDATE_CACHE_MS || 15_000);
const SHADOW_RECORDING_PAUSED = envFlag(process.env.SHADOW_RECORDING_PAUSED, false);
const DISLOCATION_OBSERVATION_PAUSED = envFlag(
  process.env.DISLOCATION_OBSERVATION_PAUSED, false,
);
const PAPER_ENTRIES_PAUSED = envFlag(process.env.PAPER_ENTRIES_PAUSED, false);
const MICRO_MAINNET_CONFIG = microMainnetConfigFromEnv(process.env);
const SIGNING_ATTESTATION_FILE = String(process.env.TURNKEY_SIGNING_ATTESTATION_FILE || "");
const SIGNING_ATTESTATION_PUBLIC_KEY = process.env.TURNKEY_SIGNING_ATTESTATION_PUBLIC_KEY_PEM_B64
  ? Buffer.from(process.env.TURNKEY_SIGNING_ATTESTATION_PUBLIC_KEY_PEM_B64, "base64").toString("utf8") : "";
const PAPER_STRATEGY_VERSION = "2026-09-15-paper-v6b-lossless-recovery";
const EVIDENCE_DIR = String(process.env.EVIDENCE_DIR
  || (STATE_FILE ? join(dirname(STATE_FILE), "evidence") : ""));
const EVIDENCE_FILE = EVIDENCE_DIR
  ? join(EVIDENCE_DIR, `${PAPER_STRATEGY_VERSION}.jsonl`) : "";
const GAS_MEASUREMENT_CONFIG = gasMeasurementFromEnv(process.env);
let GAS_MEASUREMENT = { verifiedInput: false, measuredAt: null, lastVerifiedAt: null,
  observedCostWei: null, observedCostWeth: null,
  configuredWethPerSide: GAS_MEASUREMENT_CONFIG.configuredWethPerSide,
  failures: [...GAS_MEASUREMENT_CONFIG.failures] };
const SELL_PROBE_CONFIG = sellProbeConfigFromEnv(process.env);
let sellProbeLastAttemptAt = 0;
let sellProbePromise = null;
let latestSellProbeCandidates = [];
let SELL_PROBE_OVERRIDE_STATUS = {
  checked: false, supported: false, checkedAt: null, failures: [],
};
let SELL_PROBE_STATUS = {
  configured: SELL_PROBE_CONFIG.configured,
  passed: false,
  lastAttemptAt: null,
  lastSuccessAt: null,
  checkedPool: null,
  method: null,
  observedHolderPassed: false,
  selfSimulationPassed: false,
  failures: [...SELL_PROBE_CONFIG.failures],
};
const sellProbeByPool = new Map();
const QUALIFYING_PAPER_STRATEGY = Object.freeze({
  ...DEFAULT_PAPER_STRATEGY,
  maxHoldMs: 30 * 60_000,
});
const QUALIFYING_PAPER_RISK_POLICY = Object.freeze({
  ...DEFAULT_PAPER_POLICY,
  maxPriceImpactPct: 1.5,
  maxExecutionCostPct: 4,
  requireGasEstimate: true,
  allowedSignals: ["active"],
  minSwaps: 4,
  minAcceleration: 0.75,
  maxAcceleration: 1.5,
});

const PAIR_CREATED = "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9";
const POOL_CREATED = "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118";
const V2_SWAP = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
const PANCAKE_V3_SWAP = "0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83";
const UNISWAP_V3_SWAP = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";

const pools = new Map();
 const v3BoundaryCache = new Map();
const wethPaperPortfolio = new PaperPortfolio({
  initialCash: PAPER_WETH_INITIAL_CASH, maxPositions: PAPER_MAX_POSITIONS,
});
const paperBooks = new Map([
  [ROBINHOOD.usdg.toLowerCase(), {
    symbol: "USDG",
    portfolio: new PaperPortfolio({ initialCash: PAPER_INITIAL_CASH, maxPositions: PAPER_MAX_POSITIONS }),
  }],
  [ROBINHOOD.weth.toLowerCase(), { symbol: "WETH", portfolio: wethPaperPortfolio }],
]);
const rpcScheduler = new RpcScheduler({ minIntervalMs: RPC_MIN_INTERVAL_MS, jitterMs: RPC_JITTER_MS });
const rpcTransport = new RpcTransport({ urls: RPC_URLS });
const sellProbeRpcScheduler = new RpcScheduler({
  minIntervalMs: RPC_MIN_INTERVAL_MS, jitterMs: RPC_JITTER_MS,
});
const sellProbeRpcTransport = new RpcTransport({ urls: RPC_URLS });
let logDeduplicator = new LogDeduplicator();
let positionLiveness = new PositionLiveness();
let nextPollDelayMs = POLL_MS;
let lastPaperCycleAt = 0;
let candidateCache = null;
let candidatePromise = null;
const paperAutomation = {
  cycles: 0, entries: 0, exits: 0, recoverySkippedBlocks: 0,
  recoveryExitCycles: 0, recoveryExits: 0, lastRecoveryExitCycleAt: null,
  maxMarkedDrawdownPctByQuote: {},
  firstCycleAt: null, lastCycleAt: null, lastError: null, recentDecisions: [],
};
const shadowEvaluator = new ShadowEvaluator();
const dislocationObserver = new PassiveDislocationObserver({
  quoteToken: ROBINHOOD.weth.toLowerCase(),
});
const evidenceJournal = new EvidenceJournal(EVIDENCE_FILE);
// These three components must always share one serializer. The persistence
// callback intentionally checkpoints their live snapshots together, so a
// second serializer would break cross-component checkpoint atomicity.
const serializeExecutionMutation = createExecutionMutationSerializer();
const executionPersist = async (_snapshot, event) => {
  if (persistence.writeBlocked) throw new Error("execution-persistence-blocked");
  try {
    return await appendEvidence(event);
  } catch (error) {
    // appendEvidence already blocks on journal/checkpoint failure. Keep the
    // execution boundary independently fail-closed if that implementation
    // changes or another persistence failure reaches this callback.
    persistence.writeBlocked = true;
    persistence.automationBlockedReason ||= "execution-persistence-failed";
    persistence.lastError = error instanceof Error ? error.message : String(error);
    throw error;
  }
};
let executionJournal = new ExecutionJournal({}, {
  persist: executionPersist, serialize: serializeExecutionMutation,
});
let executionNonceLane = new NonceLane({}, {
  persist: executionPersist, serialize: serializeExecutionMutation,
});
let executionSpendLedger = new DailySpendLedger({}, {
  persist: executionPersist, serialize: serializeExecutionMutation,
});
let paperArchives = [];
const metrics = {
  startedAt: Date.now(), latestBlock: 0, blockTimestamp: 0, cursor: 0,
  recoverySkippedBlocks: 0,
  recoveryRemainingBlocks: 0, recoveryActiveSince: null,
  lastRecoveryCompletedAt: null, lastRecoveryDurationMs: null,
  successfulPolls: 0, failedPolls: 0, lastError: null,
  backfill: { active: false, from: 0, to: 0, current: 0 },
  v2Pools: 0, v3Pools: 0, swaps: 0, rpcLatencyMs: 0,
};
const persistence = {
  enabled: Boolean(STATE_FILE), restored: false, restoredCursor: null, restoredPoolCount: 0,
  lastSavedAt: null, lastAttemptAt: 0, lastError: null,
  writeBlocked: false, automationBlockedReason: null,
  stateFile: STATE_FILE ? "configured" : null, restoredAt: null, restartDowntimeMs: null,
};
const turnkeyEnvironment = turnkeyConfigFromEnv(process.env);
const turnkeyStatus = {
  configured: turnkeyEnvironment.configured,
  identifiersValid: turnkeyEnvironment.identifiersValid,
  missing: turnkeyEnvironment.missing,
  policyId: turnkeyEnvironment.config.policyId || null,
  readOnlyAttested: turnkeyEnvironment.readOnlyAttested,
  readOnlyVerified: false, apiKeyOwned: false, rootQuorumMember: null,
  attestedPolicyVisible: false, attestedDenyPolicyValid: false,
  applicableAllowPolicyCount: null, policyFailures: [],
  checked: false, authenticated: false, walletVisible: false, addressMatch: false,
  walletAccountId: null, accountCount: 0, lastError: null,
};
const turnkeySigningStatus = {
  checked: false, verified: false, credentialVerified: false,
  apiKeyOwned: false, rootQuorumMember: null,
  expectedPolicySetExact: false,
  applicableAllowPolicyCount: null,
  attestationVerified: false, attestationExpiresAt: null,
  walletBalanceVerified: false, walletWethBalanceWei: null,
  failures: MICRO_MAINNET_CONFIG.requested ? ["external-signing-verification-required"] : [],
  lastError: null,
};

async function appendEvidence(payload) {
  const records = await appendEvidenceBatch([payload]);
  return records[0];
}

async function appendEvidenceBatch(payloads) {
  try {
    if (await blockIfExecutionRecoveryActive()) {
      throw new Error("execution-recovery-in-progress");
    }
    const recordedAt = Date.now();
    const records = await evidenceJournal.appendMany(payloads.map((payload) => ({
      epoch: PAPER_STRATEGY_VERSION,
      recordedAt,
      chainBlock: metrics.latestBlock,
      ...payload,
    })));
    if (!await persistState(true)) throw new Error("evidence-state-persist-failed");
    return records;
  } catch (error) {
    persistence.automationBlockedReason ||= "evidence-journal-failed";
    persistence.lastError = error instanceof Error ? error.message : String(error);
    persistence.writeBlocked = true;
    throw error;
  }
}

async function blockIfExecutionRecoveryActive() {
  if (!STATE_FILE) return false;
  try {
    if (!await executionRecoveryLockPresent(STATE_FILE)) return false;
  } catch {
    persistence.writeBlocked = true;
    persistence.automationBlockedReason = "execution-recovery-lock-check-failed";
    persistence.lastError = "execution-recovery-lock-check-failed";
    return true;
  }
  persistence.writeBlocked = true;
  persistence.automationBlockedReason = "execution-recovery-in-progress";
  persistence.lastError = "execution-recovery-in-progress";
  return true;
}

async function verifyTurnkeyConfiguration() {
  if (!turnkeyEnvironment.configured || !turnkeyEnvironment.identifiersValid) return;
  try {
    const config = turnkeyEnvironment.config;
    const client = new Turnkey({
      apiBaseUrl: "https://api.turnkey.com",
      defaultOrganizationId: config.organizationId,
      apiPublicKey: config.apiPublicKey,
      apiPrivateKey: config.apiPrivateKey,
    }).apiClient();
    const [wallet, policy, observerIdentity] = await Promise.all([
      probeTurnkeyWallet({ config,
        getWalletAccounts: (request) => client.getWalletAccounts(request) }),
      probeTurnkeyPolicy({ config,
        getWhoami: (request) => client.getWhoami(request),
        getOrganizationConfigs: (request) => client.getOrganizationConfigs(request),
        getPolicies: (request) => client.getPolicies(request),
        getUser: (request) => client.getUser(request),
      }),
      client.getWhoami({ organizationId: config.organizationId }),
    ]);
    Object.assign(turnkeyStatus, wallet, policy,
    { checked: true, lastError: null });
    if (MICRO_MAINNET_CONFIG.requested && MICRO_MAINNET_CONFIG.configured) {
      await verifyAttestedSigningConfiguration(client, observerIdentity?.userId);
    }
  } catch {
    turnkeyStatus.checked = true;
    turnkeyStatus.lastError = "turnkey-verification-failed";
    if (MICRO_MAINNET_CONFIG.requested) Object.assign(turnkeySigningStatus, {
      checked: true, verified: false, credentialVerified: false,
      attestationVerified: false, walletBalanceVerified: false,
      walletWethBalanceWei: null,
      failures: ["observer-policy-revalidation-failed"],
      lastError: "external-signing-verification-failed",
    });
    console.error("Turnkey read-only verification failed");
  }
}

async function verifyAttestedSigningConfiguration(client, observerUserId) {
  const failures = [];
  let stage = "attestation";
  try {
    if (!SIGNING_ATTESTATION_FILE || !SIGNING_ATTESTATION_PUBLIC_KEY) {
      throw new Error("signing-attestation-config-required");
    }
    const document = await readSigningAttestation(SIGNING_ATTESTATION_FILE);
    const attestation = verifySigningAttestation({ document,
      config: MICRO_MAINNET_CONFIG, publicKeyPem: SIGNING_ATTESTATION_PUBLIC_KEY });
    failures.push(...attestation.failures);
    if (!attestation.verified) throw new Error("signing-attestation-invalid");
    if (attestation.claims.observerUserId !== observerUserId) {
      failures.push("signing-attestation-observer-user-mismatch");
      throw new Error("signing-attestation-observer-user-mismatch");
    }
    const signingUserId = attestation.claims.signingUserId;
    stage = "turnkey";
    const [organizationConfigs, policies, user] = await Promise.all([
      client.getOrganizationConfigs({ organizationId: MICRO_MAINNET_CONFIG.organizationId }),
      client.getPolicies({ organizationId: MICRO_MAINNET_CONFIG.organizationId }),
      client.getUser({ organizationId: MICRO_MAINNET_CONFIG.organizationId, userId: signingUserId }),
    ]);
    const policy = assessTurnkeySigningPolicy({ config: MICRO_MAINNET_CONFIG,
      whoami: { userId: signingUserId }, organizationConfigs, policies,
      user: user?.user || user });
    failures.push(...policy.failures);
    stage = "balance";
    const balanceCall = `0x70a08231000000000000000000000000${MICRO_MAINNET_CONFIG.walletAddress.slice(2)}`;
    const walletWethBalanceWei = BigInt(await rpc("eth_call", [{
      to: ROBINHOOD.weth, data: balanceCall,
    }, "latest"])).toString();
    Object.assign(turnkeySigningStatus, policy, {
      checked: true,
      verified: attestation.verified && policy.verified && failures.length === 0,
      credentialVerified: attestation.verified && policy.apiKeyOwned === true
        && policy.rootQuorumMember === false,
      attestationVerified: attestation.verified,
      attestationExpiresAt: attestation.claims.expiresAt,
      walletBalanceVerified: true,
      walletWethBalanceWei,
      failures: [...new Set(failures)], lastError: null,
    });
  } catch {
    const fixedFailure = {
      attestation: "signing-attestation-read-failed",
      turnkey: "turnkey-revalidation-failed",
      balance: "weth-balance-read-failed",
    }[stage];
    Object.assign(turnkeySigningStatus, {
      checked: true, verified: false, credentialVerified: false,
      attestationVerified: false, walletBalanceVerified: false,
      walletWethBalanceWei: null,
      failures: [...new Set(failures.length ? failures : [fixedFailure])],
      lastError: "external-signing-verification-failed",
    });
  }
}

async function verifyConfiguredGasMeasurement() {
  GAS_MEASUREMENT = await verifyGasMeasurement({ config: GAS_MEASUREMENT_CONFIG,
    getReceipt: (transactionHash) => rpc("eth_getTransactionReceipt", [transactionHash]),
    getBlock: (blockNumber) => rpc("eth_getBlockByNumber", [blockNumber, false]),
  });
}

function persistedState() {
  return {
    cursor: metrics.cursor,
    pools: [...pools.values()],
    paperBooks: Object.fromEntries([...paperBooks].map(([quoteToken, book]) => [
      quoteToken, { symbol: book.symbol, state: book.portfolio.serialize() },
    ])),
    paperStrategyVersion: PAPER_STRATEGY_VERSION,
    paperArchives,
    paperAutomation,
    shadow: shadowEvaluator.serialize(),
    passiveDislocations: dislocationObserver.serialize(),
    processedLogs: logDeduplicator.serialize(),
    positionLiveness: positionLiveness.serialize(),
    execution: {
      journal: executionJournal.snapshot(),
      nonceLane: executionNonceLane.snapshot(),
      spendLedger: executionSpendLedger.snapshot(),
    },
    evidenceSequence: evidenceJournal.snapshot().sequence,
    evidenceLastHash: evidenceJournal.snapshot().lastHash,
  };
}

async function restoreState() {
  if (!STATE_FILE) return;
  try {
    const state = await loadJsonState(STATE_FILE);
    if (!state) {
      if (evidenceJournal.snapshot().sequence > 0) throw new Error("evidence-state-divergence");
      return;
    }
    for (const savedPool of (state.pools || []).slice(0, MAX_POOLS)) {
      const pool = {
        ...savedPool,
        recentBlocks: Array.isArray(savedPool.recentBlocks)
          ? savedPool.recentBlocks.filter((bucket) => Number.isFinite(Number(bucket.timestampMs)))
          : [],
      };
      delete pool.recent;
      pools.set(pool.address, pool);
    }
    metrics.cursor = Number(state.cursor) || 0;
    metrics.v2Pools = [...pools.values()].filter((pool) => pool.version === "v2").length;
    metrics.v3Pools = [...pools.values()].filter((pool) => pool.version === "v3").length;
    metrics.swaps = [...pools.values()].reduce((sum, pool) => sum + (Number(pool.swapCount) || 0), 0);
    paperArchives = Array.isArray(state.paperArchives) ? state.paperArchives.slice(-4) : [];
    const inferredPaperVersion = Object.values(state.paperBooks || {})
      .flatMap((book) => book?.state?.trades || [])
      .map((trade) => trade?.audit?.strategyVersion)
      .filter(Boolean)
      .at(-1);
    const savedPaperVersion = state.paperStrategyVersion
      || inferredPaperVersion || "legacy-paper-cohort";
    const samePaperEpoch = savedPaperVersion === PAPER_STRATEGY_VERSION;
    if (!samePaperEpoch && evidenceJournal.snapshot().sequence > 0) {
      throw new Error("evidence-state-divergence");
    }
    if (samePaperEpoch) validateEvidenceCheckpoint({
      state, journal: evidenceJournal.snapshot(),
    });
    if (!samePaperEpoch && state.execution) {
      validateExecutionCheckpoint({ execution: state.execution,
        typeCounts: evidenceJournal.snapshot().typeCounts });
    }
    executionJournal = new ExecutionJournal(state.execution?.journal,
      { persist: executionPersist, serialize: serializeExecutionMutation });
    executionNonceLane = new NonceLane(state.execution?.nonceLane,
      { persist: executionPersist, serialize: serializeExecutionMutation });
    executionSpendLedger = new DailySpendLedger(state.execution?.spendLedger,
      { persist: executionPersist, serialize: serializeExecutionMutation });
    if (state.paperBooks && samePaperEpoch) {
      for (const [quoteToken, saved] of Object.entries(state.paperBooks)) {
        const book = paperBooks.get(quoteToken.toLowerCase());
        if (book && saved?.state) book.portfolio.restore(saved.state);
      }
    } else if (state.paperBooks) {
      paperArchives.push({
        version: savedPaperVersion,
        archivedAt: Date.now(),
        books: state.paperBooks,
        automation: state.paperAutomation || null,
      });
      paperArchives = paperArchives.slice(-5);
    }
    if (state.paperAutomation && samePaperEpoch) {
      Object.assign(paperAutomation, state.paperAutomation);
    }
    if (state.shadow) shadowEvaluator.restore(state.shadow);
    if (state.passiveDislocations) {
      dislocationObserver.restore(state.passiveDislocations);
    }
    logDeduplicator = new LogDeduplicator({ entries: state.processedLogs || [] });
    positionLiveness = new PositionLiveness({
      state: samePaperEpoch ? (state.positionLiveness || {}) : {},
    });
    if (!persistence.writeBlocked) {
      await finalizeExecutionNonceResidue({ journal: executionJournal,
        nonceLane: executionNonceLane });
    }
    persistence.restored = true;
    persistence.restoredCursor = metrics.cursor;
    persistence.restoredPoolCount = pools.size;
    persistence.lastSavedAt = state.savedAt;
    persistence.restoredAt = Date.now();
    persistence.restartDowntimeMs = Number.isFinite(Number(state.savedAt))
      ? Math.max(0, persistence.restoredAt - Number(state.savedAt)) : null;
  } catch (error) {
    persistence.lastError = error instanceof Error ? error.message : String(error);
    persistence.writeBlocked = true;
    persistence.automationBlockedReason = "state-restore-failed";
    console.error(`State restore failed; persistence and paper automation blocked: ${persistence.lastError}`);
  }
}

async function initializeEvidenceJournal() {
  try {
    const initialized = await evidenceJournal.initialize();
    if (!initialized) persistence.automationBlockedReason = "evidence-journal-disabled";
  } catch (error) {
    persistence.automationBlockedReason = "evidence-journal-failed";
    persistence.lastError = error instanceof Error ? error.message : String(error);
    persistence.writeBlocked = true;
  }
}

async function persistState(force = false) {
  if (!STATE_FILE || persistence.writeBlocked) return false;
  const now = Date.now();
  if (!force && now - persistence.lastAttemptAt < STATE_SAVE_MS) return true;
  persistence.lastAttemptAt = now;
  try {
    await saveJsonState(STATE_FILE, persistedState());
    persistence.lastSavedAt = Date.now();
    persistence.lastError = null;
    return true;
  } catch (error) {
    persistence.lastError = error instanceof Error ? error.message : String(error);
    return false;
  }
}

async function rpc(method, params) {
  return rpcScheduler.schedule(async () => {
    const started = Date.now();
    try {
      return await rpcTransport.request(method, params);
    } finally {
      metrics.rpcLatencyMs = Date.now() - started;
    }
  });
}

async function sellProbeRpc(method, params) {
  return sellProbeRpcScheduler.schedule(() => sellProbeRpcTransport.request(method, params));
}

async function verifySellProbeOverrideSupport() {
  if (!SELL_PROBE_CONFIG.configured) return;
  SELL_PROBE_OVERRIDE_STATUS = await probeStateOverrideSupport({
    token: ROBINHOOD.weth,
    walletAddress: turnkeyEnvironment.config.walletAddress,
    balanceSlot: SELL_PROBE_CONFIG.canaryBalanceSlot,
    rpc: sellProbeRpc,
  });
  if (!SELL_PROBE_OVERRIDE_STATUS.supported) {
    SELL_PROBE_STATUS = { ...SELL_PROBE_STATUS, passed: false,
      observedHolderPassed: false, selfSimulationPassed: false,
      failures: [...SELL_PROBE_OVERRIDE_STATUS.failures] };
  }
}

const tokenMeta = createTokenMetadataLoader({
  call: (address, data) => rpc("eth_call", [{ to: address, data }, "latest"]),
  pinned: ROBINHOOD.quoteTokens,
});

const hexBlock = (n) => `0x${n.toString(16)}`;
const intHex = (value) => Number.parseInt(value || "0x0", 16);
const topicAddress = (topic) => `0x${String(topic).slice(-40)}`.toLowerCase();
const dataWord = (data, index) => String(data).slice(2 + index * 64, 66 + index * 64);
const wordAddress = (data, index) => `0x${dataWord(data, index).slice(-40)}`.toLowerCase();

async function getLogs(from, to, address, topics) {
  const result = await fetchLogsAdaptive({ request: rpc, from, to, address, topics });
  return (result || []).map((log) => ({ ...log, blockNumber: intHex(log.blockNumber) }));
}

function registerPool(pool) {
  if (pools.has(pool.address) || pools.size >= MAX_POOLS) return;
  pools.set(pool.address, {
    ...pool,
    swapCount: 0,
    lastSwapBlock: 0,
    lastSwapTimestampMs: 0,
    recentBlocks: [],
  });
  if (pool.version === "v2") metrics.v2Pools += 1;
  else metrics.v3Pools += 1;
}

async function discover(from, to, rangeTimes) {
  const factories = new Map(ROBINHOOD.factories.map(
    (factory) => [factory.address.toLowerCase(), factory],
  ));
  const logs = await getLogs(from, to, [...factories.keys()], [[PAIR_CREATED, POOL_CREATED]]);
  for (const log of logs) {
    const factory = factories.get(String(log.address).toLowerCase());
    if (!factory) continue;
    const poolWord = factory.version === "v2" ? 0 : 1;
    if (log.topics.length < (factory.version === "v2" ? 3 : 4) || dataWord(log.data, poolWord).length !== 64) continue;
    registerPool({
      address: wordAddress(log.data, poolWord), dex: factory.dex, version: factory.version,
      token0: topicAddress(log.topics[1]), token1: topicAddress(log.topics[2]),
      fee: factory.version === "v3" ? intHex(log.topics[3]) : null,
      discoveryBlock: log.blockNumber,
      discoveryTimestampMs: estimateBlockTimestamp(log.blockNumber, rangeTimes),
    });
  }
}

function recordSwap(log, timestampMs) {
  const pool = pools.get(String(log.address).toLowerCase());
  if (!pool) return;
  if (!logDeduplicator.accept(log)) return;
  pool.swapCount += 1;
  pool.lastSwapBlock = log.blockNumber;
  pool.lastSwapTimestampMs = timestampMs;
  const blocks = pool.recentBlocks || (pool.recentBlocks = []);
  const last = blocks.at(-1);
  if (last?.blockNumber === log.blockNumber) last.count += 1;
  else blocks.push({ blockNumber: log.blockNumber, timestampMs, count: 1 });
  const historyFloor = timestampMs - SIGNAL_HISTORY_MS;
  while (blocks.length && blocks[0].timestampMs < historyFloor) blocks.shift();
  try {
    pool.lastSwap = {
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash,
      ...decodeSwapEvent(log, pool.version),
    };
    pool.decodeError = null;
  } catch (error) {
    pool.decodeError = error instanceof Error ? error.message : String(error);
  }
  metrics.swaps += 1;
}

async function observeSwaps(from, to, rangeTimes) {
  const logs = await getLogs(
    from, to, undefined, [[V2_SWAP, PANCAKE_V3_SWAP, UNISWAP_V3_SWAP]],
  );
  logs.forEach((log) => recordSwap(
    log, estimateBlockTimestamp(log.blockNumber, rangeTimes),
  ));
}

async function blockRangeTimes(from, to) {
  const [first, last] = await Promise.all([
    rpc("eth_getBlockByNumber", [hexBlock(from), false]),
    from === to
      ? Promise.resolve(null)
      : rpc("eth_getBlockByNumber", [hexBlock(to), false]),
  ]);
  const fromTimestampMs = intHex(first?.timestamp) * 1_000;
  const toTimestampMs = (last ? intHex(last.timestamp) : intHex(first?.timestamp)) * 1_000;
  if (!Number.isFinite(fromTimestampMs) || fromTimestampMs <= 0
      || !Number.isFinite(toTimestampMs) || toTimestampMs <= 0) {
    throw new Error("block-timestamp-unavailable");
  }
  return { from, to, fromTimestampMs, toTimestampMs };
}

function estimateBlockTimestamp(blockNumber, rangeTimes) {
  if (rangeTimes.to <= rangeTimes.from) return rangeTimes.fromTimestampMs;
  const ratio = (blockNumber - rangeTimes.from) / (rangeTimes.to - rangeTimes.from);
  return Math.round(
    rangeTimes.fromTimestampMs
      + ratio * (rangeTimes.toTimestampMs - rangeTimes.fromTimestampMs),
  );
}

async function scanRange(from, to) {
  for (let start = from; start <= to; start += CHUNK) {
    const end = Math.min(start + CHUNK - 1, to);
    const rangeTimes = await blockRangeTimes(start, end);
    await discover(start, end, rangeTimes);
    await observeSwaps(start, end, rangeTimes);
    logDeduplicator.prune(end);
    metrics.cursor = end;
    if (metrics.backfill.active) metrics.backfill.current = end;
  }
}

async function bootstrap(latest) {
  const from = Math.max(1, latest - BACKFILL);
  metrics.backfill = { active: true, from, to: latest, current: from };
  try {
    await scanRange(from, latest);
  } finally {
    metrics.backfill.active = false;
    metrics.backfill.current = Math.min(metrics.cursor || from, latest);
  }
}

async function poll() {
  try {
    const latest = intHex(await rpc("eth_blockNumber", []));
    metrics.latestBlock = latest;
    let caughtUp = true;
    if (!metrics.cursor) await bootstrap(latest);
    else if (latest > metrics.cursor) {
      caughtUp = false;
      if (!metrics.recoveryActiveSince) metrics.recoveryActiveSince = Date.now();
      const recovery = planLosslessRecovery({
        cursor: metrics.cursor,
        latest,
        maxBlocksPerPoll: MAX_RECOVERY_BLOCKS_PER_POLL,
      });
      await scanRange(recovery.from, recovery.to);
    }
    metrics.recoveryRemainingBlocks = Math.max(0, latest - metrics.cursor);
    if (metrics.recoveryRemainingBlocks === 0 && metrics.recoveryActiveSince) {
      const completedAt = Date.now();
      metrics.lastRecoveryDurationMs = completedAt - metrics.recoveryActiveSince;
      metrics.lastRecoveryCompletedAt = completedAt;
      metrics.recoveryActiveSince = null;
    }
    const block = await rpc("eth_getBlockByNumber", [hexBlock(latest), false]);
    metrics.blockTimestamp = intHex(block?.timestamp);
    metrics.successfulPolls += 1;
    metrics.lastError = null;
    nextPollDelayMs = caughtUp ? POLL_MS : 1_000;
    const ready = assessReadiness({
      latestBlock: metrics.latestBlock, cursor: metrics.cursor,
      backfillActive: metrics.backfill.active, lastError: metrics.lastError,
    });
    if (!persistence.automationBlockedReason
        && Date.now() - lastPaperCycleAt >= PAPER_CYCLE_MS) {
      const openPositions = [...paperBooks.values()].reduce(
        (total, book) => total + book.portfolio.snapshot().openPositions.length, 0,
      );
      const cycleMode = recoveryPaperCycleMode({
        synchronized: ready.readyForPaper,
        openPositions,
      });
      if (cycleMode === "full") {
        await runPaperCycle();
        scheduleSellProbe(latestSellProbeCandidates);
      } else if (cycleMode === "exits-only") {
        await runPaperCycle({ exitsOnly: true, duringRecovery: true });
      }
    }
    await persistState();
  } catch (error) {
    metrics.failedPolls += 1;
    metrics.lastError = error instanceof Error ? error.message : String(error);
    const rateLimited = isRpcThrottleError(metrics.lastError);
    nextPollDelayMs = nextBackoffMs({
      currentMs: nextPollDelayMs, rateLimited, baseMs: POLL_MS,
    });
  } finally {
    await persistState();
    setTimeout(poll, nextPollDelayMs);
  }
}

const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
})[c]);

function snapshot() {
  const backfill = {
    ...metrics.backfill,
    active: metrics.backfill.active && metrics.cursor <= metrics.backfill.to,
    current: Math.min(metrics.backfill.current, metrics.backfill.to),
  };
  const readiness = assessReadiness({
    latestBlock: metrics.latestBlock, cursor: metrics.cursor,
    backfillActive: backfill.active, lastError: metrics.lastError,
  });
  const execution = executionStatus(readiness.readyForPaper);
  return {
    mode: PAPER_ENTRIES_PAUSED ? "PAPER_ENTRIES_PAUSED" : "PAPER_ONLY",
    chainId: CHAIN_ID, uptimeSeconds: Math.floor((Date.now() - metrics.startedAt) / 1000),
    latestBlock: metrics.latestBlock, blockTimestamp: metrics.blockTimestamp,
    cursor: metrics.cursor, polling: {
      configuredIntervalMs: POLL_MS, nextDelayMs: nextPollDelayMs, successful: metrics.successfulPolls,
      failed: metrics.failedPolls, lastError: metrics.lastError,
    },
    recovery: {
      policy: "lossless-bounded-catchup",
      maxBlocksPerPoll: MAX_RECOVERY_BLOCKS_PER_POLL,
      skippedBlocks: metrics.recoverySkippedBlocks,
      remainingBlocks: Math.max(0, metrics.latestBlock - metrics.cursor),
      activeSince: metrics.recoveryActiveSince,
      lastCompletedAt: metrics.lastRecoveryCompletedAt,
      lastDurationMs: metrics.lastRecoveryDurationMs,
    },
    backfill,
    poolDiscovery: { v2Pools: metrics.v2Pools, v3Pools: metrics.v3Pools,
      totalPools: pools.size, swapsObserved: metrics.swaps, capacity: MAX_POOLS },
    venues: Object.fromEntries(["pancakeswap", "uniswap"].map((dex) => [dex,
      [...pools.values()].filter((pool) => pool.dex === dex).length])),
    rpcLatencyMs: metrics.rpcLatencyMs,
    rpcScheduler: rpcScheduler.snapshot(),
    rpcTransport: rpcTransport.snapshot(),
    v3BoundarySearch: {
      cachedWords: v3BoundaryCache.size,
      method: "current-word-conservative-edge",
    },
    readiness,
    persistence,
    evidence: evidenceJournal.snapshot(),
    gasMeasurement: GAS_MEASUREMENT,
    sellProbe: publicSellProbeStatus(),
    turnkey: turnkeyStatus,
    execution,
  };
}

function signals(limit = 25) {
  const nowMs = (metrics.blockTimestamp * 1_000) || Date.now();
  return rankPools([...pools.values()], nowMs, {
    windowMs: SIGNAL_WINDOW_MS,
    baselineMs: SIGNAL_BASELINE_MS,
    minSwaps: SIGNAL_MIN_SWAPS,
  }).slice(0, limit);
}

async function resolveV3Boundary(pool, currentTick, tickSpacing, zeroForOne) {
  const compressedTick = compressTick(currentTick, tickSpacing);
  const { wordPos } = bitmapPosition(compressedTick);
  const key = `${pool.address}:${zeroForOne ? "down" : "up"}:${wordPos}`;
  const cached = v3BoundaryCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.boundaryTick;

  const currentBitmap = decodeUint(await rpc("eth_call", [{
    to: pool.address, data: encodeInt16Call("0x5339c296", wordPos),
  }, "latest"]), "tick-bitmap");
  const initializedTick = findInitializedTickInWord({
    bitmap: currentBitmap, wordPos, currentCompressedTick: compressedTick,
    tickSpacing, zeroForOne,
  });
  const conservativeWordEdge = (
    zeroForOne ? wordPos * 256 : (wordPos + 1) * 256
  ) * tickSpacing;
  const boundaryTick = initializedTick ?? conservativeWordEdge;
  v3BoundaryCache.set(key, {
    boundaryTick, expiresAt: Date.now() + V3_BOUNDARY_CACHE_MS,
  });
  return boundaryTick;
}

async function ensureDiscoveryTimestamp(pool) {
  if (Number.isFinite(Number(pool.discoveryTimestampMs))
      && Number(pool.discoveryTimestampMs) > 0) return Number(pool.discoveryTimestampMs);
  const block = await rpc("eth_getBlockByNumber", [hexBlock(pool.discoveryBlock), false]);
  const timestampMs = intHex(block?.timestamp) * 1_000;
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
    throw new Error("pool-discovery-timestamp-unavailable");
  }
  pool.discoveryTimestampMs = timestampMs;
  return timestampMs;
}

function plannedPaperNotional(quoteAddress) {
  const book = paperBooks.get(quoteAddress);
  if (!book) return null;
  const cash = Number(book.portfolio.snapshot().cash);
  const cap = book.symbol === "WETH" ? PAPER_WETH_MAX_ENTRY : PAPER_USDG_MAX_ENTRY;
  const notional = Math.min(cash * DEFAULT_PAPER_STRATEGY.entryCashPct / 100, cap);
  return Number.isFinite(notional) && notional > 0 ? notional : null;
}

function gasCostQuotePerSide(quoteAddress) {
  if (quoteAddress === ROBINHOOD.weth.toLowerCase()) return PAPER_WETH_GAS_PER_SIDE;
  if (quoteAddress === ROBINHOOD.usdg.toLowerCase()) return PAPER_USDG_GAS_PER_SIDE;
  return null;
}

function withGasEstimate(safety, quoteAddress, plannedNotionalQuote) {
  const gasCost = gasCostQuotePerSide(quoteAddress);
  if (!Number.isFinite(gasCost) || gasCost < 0
      || !Number.isFinite(plannedNotionalQuote) || plannedNotionalQuote <= 0) {
    return { ...safety, gasEstimateAvailable: false };
  }
  const roundTripGasCostPct = (gasCost * 2 / plannedNotionalQuote) * 100;
  const executionCostPct = Number(safety.executionCostPct);
  return {
    ...safety,
    gasEstimateAvailable: GAS_MEASUREMENT.verifiedInput
      && quoteAddress === ROBINHOOD.weth.toLowerCase(),
    gasCostQuotePerSide: gasCost,
    roundTripGasCostPct,
    executionCostPct: Number.isFinite(executionCostPct)
      ? executionCostPct + roundTripGasCostPct : executionCostPct,
  };
}

function humanToUnits(value, decimals) {
  const precision = Math.min(Number(decimals), 12);
  const scaled = Math.floor(Number(value) * (10 ** precision));
  if (!Number.isSafeInteger(scaled) || scaled <= 0) throw new Error("invalid-token-amount");
  return BigInt(scaled) * (10n ** BigInt(Number(decimals) - precision));
}

function unitsToHuman(value, decimals) {
  const human = Number(BigInt(value)) / (10 ** Number(decimals));
  if (!Number.isFinite(human) || human <= 0) throw new Error("invalid-quote-output");
  return human;
}

async function marketSafety(pool) {
  const quoteTokens = [ROBINHOOD.weth, ROBINHOOD.usdg];
  const quoteAddresses = quoteTokens.map((address) => address.toLowerCase());
  const quoteIsToken0 = quoteAddresses.includes(pool.token0);
  const quoteIsToken1 = quoteAddresses.includes(pool.token1);
  const base = {
    quoteTokenKnown: quoteIsToken0 !== quoteIsToken1,
    quoteToken: quoteIsToken0 ? pool.token0 : quoteIsToken1 ? pool.token1 : null,
    baseToken: quoteIsToken0 ? pool.token1 : quoteIsToken1 ? pool.token0 : null,
    liquidityKnown: false, buyMathOk: false, sellMathOk: false,
    poolAgeMs: null,
    priceImpactPct: null, roundTripLossPct: null,
  };
  if (!base.quoteTokenKnown) return base;
  try {
    const discoveryTimestampMs = await ensureDiscoveryTimestamp(pool);
    base.poolAgeMs = Math.max(
      0,
      ((metrics.blockTimestamp * 1_000) || Date.now()) - discoveryTimestampMs,
    );
    const [token0Meta, token1Meta] = await Promise.all([
      tokenMeta(pool.token0), tokenMeta(pool.token1),
    ]);
    const quoteAddress = quoteIsToken0 ? pool.token0 : pool.token1;
    const quoteDecimals = quoteIsToken0 ? token0Meta.decimals : token1Meta.decimals;
    const plannedNotionalQuote = plannedPaperNotional(quoteAddress);
    if (!plannedNotionalQuote) throw new Error("paper-notional-unavailable");
    const quoteAmountIn = humanToUnits(plannedNotionalQuote, quoteDecimals);
    if (pool.version === "v2") {
      const reserves = decodeV2Reserves(await rpc("eth_call",
        [{ to: pool.address, data: "0x0902f1ac" }, "latest"]));
      const safety = evaluateV2MarketSafety(pool, {
        latestBlock: metrics.latestBlock || metrics.cursor,
        quoteTokens, reserve0: reserves.reserve0, reserve1: reserves.reserve1,
        token0Decimals: token0Meta.decimals, token1Decimals: token1Meta.decimals,
        quoteAmountIn,
      });
      return withGasEstimate({ ...base, ...safety, poolAgeMs: base.poolAgeMs,
        plannedNotionalQuote, ...auditSwapPrice({
        spotPriceQuote: safety.tokenPriceQuote, swap: pool.lastSwap, quoteIsToken0,
        token0Decimals: token0Meta.decimals, token1Decimals: token1Meta.decimals,
      }) }, quoteAddress, plannedNotionalQuote);
    }
    const [slot0Result, liquidityResult] = await Promise.all([
      rpc("eth_call", [{ to: pool.address, data: "0x3850c7bd" }, "latest"]),
      rpc("eth_call", [{ to: pool.address, data: "0x1a686502" }, "latest"]),
    ]);
    const slot0 = decodeV3Slot0(slot0Result);
    let tickSpacing = Number(pool.tickSpacing);
    if (!Number.isInteger(tickSpacing) || tickSpacing <= 0) {
      const tickSpacingResult = await rpc("eth_call", [{
        to: pool.address, data: "0xd0c93a7c",
      }, "latest"]);
      tickSpacing = Number(decodeUint(tickSpacingResult, "tick-spacing"));
      pool.tickSpacing = tickSpacing;
    }
    const boundaryTick = await resolveV3Boundary(
      pool, slot0.tick, tickSpacing, quoteIsToken0,
    );
    const safety = evaluateV3MarketSafety(pool, {
      latestBlock: metrics.latestBlock || metrics.cursor,
      quoteTokens, sqrtPriceX96: slot0.sqrtPriceX96, currentTick: slot0.tick,
      liquidity: decodeUint(liquidityResult, "liquidity"), boundaryTick,
      token0Decimals: token0Meta.decimals, token1Decimals: token1Meta.decimals,
      quoteAmountIn,
    });
    return withGasEstimate({ ...base, ...safety, poolAgeMs: base.poolAgeMs,
      plannedNotionalQuote, ...auditSwapPrice({
      spotPriceQuote: safety.tokenPriceQuote, swap: pool.lastSwap, quoteIsToken0,
      token0Decimals: token0Meta.decimals, token1Decimals: token1Meta.decimals,
    }) }, quoteAddress, plannedNotionalQuote);
  } catch (error) {
    return { ...base, measurementError: error instanceof Error ? error.message : String(error) };
  }
}

function freshSellProbe(poolAddress, now = Date.now()) {
  const result = sellProbeByPool.get(String(poolAddress || "").toLowerCase());
  const checkedAt = Date.parse(result?.checkedAt || "");
  if (!result?.passed || !Number.isFinite(checkedAt)
      || now - checkedAt > SELL_PROBE_CONFIG.maxAgeMs) return null;
  return result;
}

function sellProbeReady(now = Date.now()) {
  const checkedAt = Date.parse(SELL_PROBE_STATUS.lastSuccessAt || "");
  return SELL_PROBE_CONFIG.configured && SELL_PROBE_STATUS.passed === true
    && Number.isFinite(checkedAt) && now - checkedAt <= SELL_PROBE_CONFIG.maxAgeMs;
}

function publicSellProbeStatus(now = Date.now()) {
  return {
    configured: SELL_PROBE_CONFIG.configured,
    ready: sellProbeReady(now),
    passed: SELL_PROBE_STATUS.passed,
    lastAttemptAt: SELL_PROBE_STATUS.lastAttemptAt,
    lastSuccessAt: SELL_PROBE_STATUS.lastSuccessAt,
    checkedPool: SELL_PROBE_STATUS.checkedPool,
    method: SELL_PROBE_STATUS.method,
    observedHolderPassed: SELL_PROBE_STATUS.observedHolderPassed === true,
    selfSimulationPassed: SELL_PROBE_STATUS.selfSimulationPassed === true,
    maxAgeMs: SELL_PROBE_CONFIG.maxAgeMs,
    failures: [...SELL_PROBE_STATUS.failures],
    overridesSupported: SELL_PROBE_OVERRIDE_STATUS.supported === true,
    overrideCanaryCheckedAt: SELL_PROBE_OVERRIDE_STATUS.checkedAt,
    probeRpcScheduler: sellProbeRpcScheduler.snapshot(),
    probeRpcTransport: sellProbeRpcTransport.snapshot(),
  };
}

async function maybeRunSellProbe(measured, now = Date.now()) {
  if (!SELL_PROBE_CONFIG.configured) return;
  if (SELL_PROBE_OVERRIDE_STATUS.supported !== true) return;
  if (now - sellProbeLastAttemptAt < SELL_PROBE_CONFIG.intervalMs) return;
  sellProbeLastAttemptAt = now;
  for (const [poolAddress, result] of sellProbeByPool) {
    const checkedAt = Date.parse(result?.checkedAt || "");
    if (!Number.isFinite(checkedAt) || now - checkedAt > SELL_PROBE_CONFIG.maxAgeMs) {
      sellProbeByPool.delete(poolAddress);
    }
  }
  const eligible = measured.filter((candidate) => (
    candidate.version === "v2"
    && candidate.marketSafety?.buyMathOk === true
    && candidate.marketSafety?.sellMathOk === true
    && candidate.lastSwap?.transactionHash
    && candidate.lastSwap?.direction === (
      candidate.token0 === candidate.marketSafety?.quoteToken
        ? "token1-to-token0" : "token0-to-token1"
    )
  )).slice(0, 3);
  if (!eligible.length) {
    SELL_PROBE_STATUS = { ...SELL_PROBE_STATUS, passed: false,
      lastAttemptAt: new Date(now).toISOString(), checkedPool: null,
      observedHolderPassed: false, selfSimulationPassed: false,
      failures: ["sell-probe-candidate-unavailable"] };
    return;
  }
  let lastResult = null;
  for (const candidate of eligible) {
    const result = await probeV2Sell({
      pool: candidate,
      safety: candidate.marketSafety,
      lastSwap: candidate.lastSwap,
      latestBlock: metrics.latestBlock,
      allowedRouters: SELL_PROBE_CONFIG.allowedRouters,
      maxSwapAgeBlocks: SELL_PROBE_CONFIG.maxSwapAgeBlocks,
      maxSlippageBps: SELL_PROBE_CONFIG.maxSlippageBps,
      maxStorageSlot: SELL_PROBE_CONFIG.maxStorageSlot,
      negativeCacheMs: SELL_PROBE_CONFIG.negativeCacheMs,
      atlasWalletAddress: turnkeyEnvironment.config.walletAddress,
      rpc: sellProbeRpc,
    });
    sellProbeByPool.set(candidate.address, result);
    lastResult = { candidate, result };
    if (result.passed) break;
  }
  const checkedAt = new Date(now).toISOString();
  SELL_PROBE_STATUS = {
    configured: true,
    passed: lastResult?.result?.passed === true,
    lastAttemptAt: checkedAt,
    lastSuccessAt: lastResult?.result?.passed
      ? lastResult.result.checkedAt : SELL_PROBE_STATUS.lastSuccessAt,
    checkedPool: lastResult?.candidate?.address || null,
    method: lastResult?.result?.method || null,
    observedHolderPassed: lastResult?.result?.observedHolderPassed === true,
    selfSimulationPassed: lastResult?.result?.selfSimulationPassed === true,
    failures: lastResult?.result?.failures || ["sell-probe-candidate-unavailable"],
  };
}

function scheduleSellProbe(measured) {
  if (sellProbePromise || !Array.isArray(measured) || !measured.length) return;
  sellProbePromise = maybeRunSellProbe(measured)
    .catch(() => {
      SELL_PROBE_STATUS = { ...SELL_PROBE_STATUS, passed: false,
        observedHolderPassed: false, selfSimulationPassed: false,
        lastAttemptAt: new Date().toISOString(), failures: ["sell-probe-background-failed"] };
    })
    .finally(() => { sellProbePromise = null; });
}

async function paperExitQuote(pool, position) {
  const quoteTokens = [ROBINHOOD.weth, ROBINHOOD.usdg].map((address) => address.toLowerCase());
  const quoteIsToken0 = quoteTokens.includes(pool.token0);
  const quoteIsToken1 = quoteTokens.includes(pool.token1);
  if (quoteIsToken0 === quoteIsToken1) throw new Error("unknown-quote-token");
  const [token0Meta, token1Meta] = await Promise.all([
    tokenMeta(pool.token0), tokenMeta(pool.token1),
  ]);
  const quoteToken = quoteIsToken0 ? pool.token0 : pool.token1;
  const quoteDecimals = quoteIsToken0 ? token0Meta.decimals : token1Meta.decimals;
  const baseDecimals = quoteIsToken0 ? token1Meta.decimals : token0Meta.decimals;
  // Prefer the exact filled base units recorded at entry. The Number path throws
  // for quantities above ~9e3 tokens at >=12 decimals (Number.isSafeInteger).
  const baseAmountIn = typeof position.quantityUnits === "string"
    ? BigInt(position.quantityUnits)
    : humanToUnits(position.quantity, baseDecimals);
  let amountOut;
  let priceImpactPct = null;
  let exitReserves = null;
  if (pool.version === "v2") {
    const { reserve0, reserve1 } = decodeV2Reserves(await rpc(
      "eth_call", [{ to: pool.address, data: "0x0902f1ac" }, "latest"],
    ));
    const reserveIn = quoteIsToken0 ? reserve1 : reserve0;
    const reserveOut = quoteIsToken0 ? reserve0 : reserve1;
    exitReserves = { quote: reserveOut.toString(), token: reserveIn.toString() };
    if (reserveIn <= 0n || reserveOut <= 0n) {
      return { quoteToken, liquidityZero: true, exitReserves };
    }
    const fill = quoteV2({
      reserveIn,
      reserveOut,
      amountIn: baseAmountIn,
      feeBps: pool.dex === "pancakeswap" ? 25 : 30,
    });
    amountOut = fill.amountOut;
    priceImpactPct = fill.priceImpactBps / 100;
  } else {
    const [slot0Result, liquidityResult] = await Promise.all([
      rpc("eth_call", [{ to: pool.address, data: "0x3850c7bd" }, "latest"]),
      rpc("eth_call", [{ to: pool.address, data: "0x1a686502" }, "latest"]),
    ]);
    const slot0 = decodeV3Slot0(slot0Result);
    const liquidity = decodeUint(liquidityResult, "liquidity");
    if (liquidity <= 0n) return { quoteToken, liquidityZero: true };
    let tickSpacing = Number(pool.tickSpacing);
    if (!Number.isInteger(tickSpacing) || tickSpacing <= 0) {
      tickSpacing = Number(decodeUint(await rpc("eth_call", [{
        to: pool.address, data: "0xd0c93a7c",
      }, "latest"]), "tick-spacing"));
      pool.tickSpacing = tickSpacing;
    }
    const zeroForOne = !quoteIsToken0;
    const boundaryTick = await resolveV3Boundary(
      pool, slot0.tick, tickSpacing, zeroForOne,
    );
    const fill = quoteV3WithinTick({
      sqrtPriceX96: slot0.sqrtPriceX96,
      liquidity,
      amountIn: baseAmountIn,
      zeroForOne,
      feeBps: Math.ceil(Number(pool.fee) / 100),
    });
    if (!staysWithinTickBoundary({
      startSqrtPriceX96: slot0.sqrtPriceX96,
      endSqrtPriceX96: fill.nextSqrtPriceX96,
      boundaryTick,
      zeroForOne,
    })) throw new Error("v3-exit-crosses-tick-boundary");
    amountOut = fill.amountOut;
  }
  const proceeds = unitsToHuman(amountOut, quoteDecimals);
  return {
    quoteToken,
    proceeds,
    executionPrice: proceeds / Number(position.quantity),
    priceImpactPct,
    baseAmountIn: baseAmountIn.toString(),
    quoteAmountOut: amountOut.toString(),
    exitReserves,
    block: metrics.latestBlock,
  };
}

async function measureCandidates(limit) {
  const quoteTokens = new Set(ROBINHOOD.quoteTokens.map(
    (token) => token.address.toLowerCase(),
  ));
  const ranked = signals(25).filter((pool) => (
    pool.version === "v2"
      && quoteTokens.has(pool.token0) !== quoteTokens.has(pool.token1)
  )).slice(0, limit);
  const measured = await Promise.all(ranked.map(async (pool) => ({
    ...pool, marketSafety: await marketSafety(pool),
  })));
  latestSellProbeCandidates = measured;
  return measured.map((candidate) => {
    const sellProbe = freshSellProbe(candidate.address);
    const withProbe = sellProbe
      ? { ...candidate, marketSafety: { ...candidate.marketSafety, sellProbe } }
      : candidate;
    return { ...withProbe,
      riskGate: evaluateRiskGate(withProbe, QUALIFYING_PAPER_RISK_POLICY) };
  });
}

async function candidates(limit = 10) {
  const boundedLimit = Math.max(1, Math.min(25, Number(limit) || 10));
  if (candidateCache && candidateCache.expiresAt > Date.now()
      && candidateCache.limit >= boundedLimit) {
    return candidateCache.value.slice(0, boundedLimit);
  }
  if (!candidatePromise) {
    candidatePromise = measureCandidates(Math.max(10, boundedLimit))
      .then((value) => {
        candidateCache = {
          value, limit: Math.max(10, boundedLimit),
          expiresAt: Date.now() + CANDIDATE_CACHE_MS,
        };
        return value;
      })
      .finally(() => { candidatePromise = null; });
  }
  return (await candidatePromise).slice(0, boundedLimit);
}

function dislocationPoolSet(maxGroups = 6) {
  const weth = ROBINHOOD.weth.toLowerCase();
  const grouped = new Map();
  for (const pool of pools.values()) {
    if (pool.version !== "v2") continue;
    const token0IsWeth = pool.token0 === weth;
    const token1IsWeth = pool.token1 === weth;
    if (token0IsWeth === token1IsWeth) continue;
    const baseToken = token0IsWeth ? pool.token1 : pool.token0;
    const values = grouped.get(baseToken) || [];
    values.push(pool);
    grouped.set(baseToken, values);
  }
  const pending = new Set(dislocationObserver.pendingPoolAddresses());
  const eligibleGroups = [...grouped.values()]
    .filter((group) => new Set(group.map((pool) => pool.dex)).size >= 2)
    .sort((a, b) => Math.max(...b.map((pool) => Number(pool.lastSwapTimestampMs) || 0))
      - Math.max(...a.map((pool) => Number(pool.lastSwapTimestampMs) || 0)))
    .slice(0, maxGroups);
  const selected = new Map(eligibleGroups.flat().map((pool) => [pool.address, pool]));
  for (const address of pending) {
    const pool = pools.get(address);
    if (pool) selected.set(address, pool);
  }
  return [...selected.values()];
}

async function measureDislocationPools() {
  return Promise.all(dislocationPoolSet().map(async (pool) => ({
    ...pool,
    marketSafety: await marketSafety(pool),
  })));
}

function poolFeeRate(pool) {
  if (pool.version === "v3") return Number(pool.fee || 3000) / 1_000_000;
  return pool.dex === "pancakeswap" ? 0.0025 : 0.003;
}

function paperEntryAudit(candidate, feeRate) {
  return {
    strategyVersion: PAPER_STRATEGY_VERSION,
    block: metrics.latestBlock,
    signal: candidate.signal?.state,
    version: candidate.version,
    venue: candidate.dex,
    score: candidate.signal?.score,
    recentSwaps: candidate.signal?.swapsCurrentWindow,
    acceleration: candidate.signal?.acceleration,
    priceImpactPct: candidate.marketSafety?.priceImpactPct,
    executionCostPct: candidate.marketSafety?.executionCostPct,
    roundTripGasCostPct: candidate.marketSafety?.roundTripGasCostPct,
    gasCostQuotePerSide: candidate.marketSafety?.gasCostQuotePerSide,
    plannedNotionalQuote: candidate.marketSafety?.plannedNotionalQuote,
    lastSwapPriceQuote: candidate.marketSafety?.lastSwapPriceQuote,
    spotVsLastSwapPct: candidate.marketSafety?.spotVsLastSwapPct,
    currentTick: candidate.marketSafety?.currentTick,
    boundaryTick: candidate.marketSafety?.boundaryTick,
    entryReserves: {
      quote: candidate.marketSafety?.reserveQuote ?? null,
      token: candidate.marketSafety?.reserveToken ?? null,
    },
    quoteAmountIn: candidate.marketSafety?.quoteAmountIn ?? null,
    buyAmountOut: candidate.marketSafety?.buyAmountOut ?? null,
    baseTokenDecimals: candidate.marketSafety?.baseTokenDecimals ?? null,
    lastSwapTransactionHash: candidate.lastSwap?.transactionHash ?? null,
    sellProbePassed: candidate.marketSafety?.sellProbe?.passed === true,
    sellProbeCheckedAt: candidate.marketSafety?.sellProbe?.checkedAt ?? null,
    sellProbeMethod: candidate.marketSafety?.sellProbe?.method ?? null,
    feeRate,
  };
}

function rememberPaperDecision(decision) {
  paperAutomation.recentDecisions.push({ at: Date.now(), ...decision });
  if (paperAutomation.recentDecisions.length > 50) paperAutomation.recentDecisions.shift();
}

function updateMarkedDrawdownHistory() {
  if (!paperAutomation.maxMarkedDrawdownPctByQuote
      || typeof paperAutomation.maxMarkedDrawdownPctByQuote !== "object") {
    paperAutomation.maxMarkedDrawdownPctByQuote = {};
  }
  for (const book of paperBooks.values()) {
    const state = book.portfolio.serialize();
    const analytics = analyzePaperTrades({
      initialCash: state.initialCash,
      trades: state.trades,
      openPositions: state.openPositions,
      strategyVersion: PAPER_STRATEGY_VERSION,
      priorMaxMarkedDrawdownPct:
        paperAutomation.maxMarkedDrawdownPctByQuote[book.symbol] || 0,
    });
    paperAutomation.maxMarkedDrawdownPctByQuote[book.symbol]
      = analytics.maxMarkedDrawdownPct;
  }
}

async function runPaperCycle({ exitsOnly = false, duringRecovery = false } = {}) {
  lastPaperCycleAt = Date.now();
  if (exitsOnly) {
    paperAutomation.recoveryExitCycles += 1;
    paperAutomation.lastRecoveryExitCycleAt = lastPaperCycleAt;
  } else {
    if (!paperAutomation.firstCycleAt) paperAutomation.firstCycleAt = lastPaperCycleAt;
    paperAutomation.lastCycleAt = lastPaperCycleAt;
    paperAutomation.cycles += 1;
  }
  try {
    for (const [quoteToken, book] of paperBooks) {
      for (const position of book.portfolio.snapshot().openPositions) {
        const key = `${quoteToken}:${position.pool}`;
        const pool = pools.get(position.pool);
        let exit = null;
        let livenessReason = null;
        if (!pool) {
          livenessReason = positionLiveness.observe(key, "unavailable");
        } else {
          try {
            exit = await paperExitQuote(pool, position);
            livenessReason = positionLiveness.observe(
              key, exit.liquidityZero ? "zero-liquidity" : "healthy",
            );
          } catch (error) {
            livenessReason = positionLiveness.observe(key, "unavailable");
            rememberPaperDecision({
              type: "mark-unavailable",
              quote: book.symbol,
              pool: position.pool,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        if (livenessReason) {
          const trade = book.portfolio.close({
            pool: position.pool,
            price: 0,
            proceeds: 0,
            fee: 0,
            reason: livenessReason,
            measurementFailure: livenessReason === "price-unavailable-timeout",
            audit: { block: metrics.latestBlock, reason: livenessReason, duringRecovery,
              exitReserves: exit?.exitReserves ?? null },
          });
          paperAutomation.exits += 1;
          if (duringRecovery) paperAutomation.recoveryExits += 1;
          await appendEvidence({ type: "paper-close", quote: book.symbol, trade });
          rememberPaperDecision({
            type: "exit", quote: book.symbol, pool: position.pool,
            reason: livenessReason, price: 0, proceeds: 0,
          });
          continue;
        }
        if (!exit || exit.liquidityZero
            || exit.quoteToken !== quoteToken
            || !Number.isFinite(exit.executionPrice)) continue;
        const marked = book.portfolio.mark(position.pool, exit.executionPrice);
        updateMarkedDrawdownHistory();
        const reason = paperExitReason({ ...marked,
          exitPriceImpactPct: exit.priceImpactPct }, Date.now(), QUALIFYING_PAPER_STRATEGY);
        if (reason) {
          const feeRate = poolFeeRate(pool);
          const fee = exit.proceeds * feeRate;
          const gasCost = gasCostQuotePerSide(quoteToken);
          const trade = book.portfolio.close({
            pool: position.pool,
            price: exit.executionPrice,
            proceeds: exit.proceeds,
            fee,
            gasCost,
            reason,
            audit: {
              block: metrics.latestBlock,
              reason,
              duringRecovery,
              feeRate,
              gasCostQuote: gasCost,
              returnPct: marked.returnPct,
              peakReturnPct: marked.peakReturnPct,
              priceImpactPct: exit.priceImpactPct,
              quoteAmountOut: exit.quoteAmountOut,
              baseAmountIn: exit.baseAmountIn,
              exitReserves: exit.exitReserves,
            },
          });
          paperAutomation.exits += 1;
          if (duringRecovery) paperAutomation.recoveryExits += 1;
          await appendEvidence({ type: "paper-close", quote: book.symbol, trade });
          rememberPaperDecision({
            type: "exit", quote: book.symbol, pool: position.pool,
            reason, price: exit.executionPrice, proceeds: exit.proceeds,
          });
        }
      }
    }

    updateMarkedDrawdownHistory();

    if (exitsOnly) {
      paperAutomation.lastError = null;
      return;
    }

    if (SHADOW_RECORDING_PAUSED && PAPER_ENTRIES_PAUSED
        && DISLOCATION_OBSERVATION_PAUSED) {
      paperAutomation.lastError = null;
      return;
    }

    const measured = await candidates(10);
    const rankedAddresses = new Set(measured.map((candidate) => candidate.address));
    const pendingPools = shadowEvaluator.pendingPoolAddresses()
      .filter((address) => !rankedAddresses.has(address))
      .map((address) => pools.get(address))
      .filter(Boolean);
    const pendingMeasurements = await Promise.all(pendingPools.map(async (pool) => ({
      address: pool.address,
      marketSafety: await marketSafety(pool),
    })));
    if (!SHADOW_RECORDING_PAUSED) {
      const previousCount = shadowEvaluator.samples.length;
      const previousState = new Map(shadowEvaluator.samples.map((sample) => [
        sample.episodeId, { closedAt: sample.closedAt, censoredAt: sample.censoredAt },
      ]));
      const block = metrics.latestBlock;
      shadowEvaluator.resolve([...measured, ...pendingMeasurements], Date.now(), { block });
      shadowEvaluator.record(measured, Date.now(), { block });
      const currentShadowRuleVersion = shadowEvaluator.snapshot().ruleVersion;
      const evidenceEvents = [];
      for (let index = 0; index < shadowEvaluator.samples.length; index += 1) {
        const sample = shadowEvaluator.samples[index];
        if (sample.ruleVersion !== currentShadowRuleVersion) continue;
        if (index >= previousCount) {
          evidenceEvents.push({ type: "shadow-open", sample: structuredClone(sample) });
          continue;
        }
        const previous = previousState.get(sample.episodeId);
        if (previous && !previous.closedAt && !previous.censoredAt
            && (sample.closedAt || sample.censoredAt)) {
          evidenceEvents.push({ type: "shadow-resolve", sample: structuredClone(sample) });
        }
      }
      if (evidenceEvents.length) await appendEvidenceBatch(evidenceEvents);
    }
    if (!DISLOCATION_OBSERVATION_PAUSED) {
      const previousCount = dislocationObserver.samples.length;
      const previousState = new Map(dislocationObserver.samples.map((sample) => [
        sample.episodeId, sample.resolvedAt,
      ]));
      const block = metrics.latestBlock;
      dislocationObserver.observe(await measureDislocationPools(), Date.now(), { block });
      const evidenceEvents = [];
      for (let index = 0; index < dislocationObserver.samples.length; index += 1) {
        const sample = dislocationObserver.samples[index];
        if (index >= previousCount) {
          evidenceEvents.push({ type: "passive-dislocation-open",
            sample: structuredClone(sample) });
        } else if (!previousState.get(sample.episodeId) && sample.resolvedAt) {
          evidenceEvents.push({ type: "passive-dislocation-resolve",
            sample: structuredClone(sample) });
        }
      }
      if (evidenceEvents.length) await appendEvidenceBatch(evidenceEvents);
    }
    if (PAPER_ENTRIES_PAUSED) {
      paperAutomation.lastError = null;
      return;
    }
    for (const candidate of measured) {
      const book = paperBooks.get(candidate.marketSafety.quoteToken);
      if (!book) {
        rememberPaperDecision({ type: "reject", pool: candidate.address,
          reasons: ["unsupported-paper-quote"] });
        continue;
      }
      const policy = book.symbol === "WETH"
        ? { ...QUALIFYING_PAPER_STRATEGY, maxEntryNotional: PAPER_WETH_MAX_ENTRY }
        : { ...QUALIFYING_PAPER_STRATEGY, maxEntryNotional: PAPER_USDG_MAX_ENTRY };
      const paperState = book.portfolio.serialize();
      const circuitFailures = paperCircuitFailures(analyzePaperTrades({
        initialCash: paperState.initialCash, trades: paperState.trades,
        openPositions: paperState.openPositions,
        strategyVersion: PAPER_STRATEGY_VERSION,
        priorMaxMarkedDrawdownPct:
          paperAutomation.maxMarkedDrawdownPctByQuote?.[book.symbol] || 0,
      }), policy);
      if (circuitFailures.length) {
        rememberPaperDecision({ type: "reject", quote: book.symbol,
          pool: candidate.address, reasons: circuitFailures });
        continue;
      }
      const plan = planPaperEntry(candidate, paperState, policy, Date.now());
      if (!plan.approved) {
        rememberPaperDecision({ type: "reject", quote: book.symbol,
          pool: candidate.address, reasons: plan.failures });
        continue;
      }
      const feeRate = poolFeeRate(candidate);
      const fee = plan.order.notional * feeRate;
      book.portfolio.open({
        ...plan.order, fee, audit: paperEntryAudit(candidate, feeRate),
      });
      paperAutomation.entries += 1;
      await appendEvidence({ type: "paper-open", quote: book.symbol,
        trade: structuredClone(book.portfolio.trades.at(-1)) });
      rememberPaperDecision({ type: "entry", quote: book.symbol, pool: candidate.address,
        price: plan.order.price, notional: plan.order.notional, fee });
    }
    updateMarkedDrawdownHistory();
    paperAutomation.lastError = null;
  } catch (error) {
    paperAutomation.lastError = error instanceof Error ? error.message : String(error);
  }
}

function paperBookStatus(book) {
  const state = book.portfolio.serialize();
  const currentAnalytics = analyzePaperTrades({
    initialCash: state.initialCash, trades: state.trades,
    openPositions: state.openPositions,
    strategyVersion: PAPER_STRATEGY_VERSION,
    priorMaxMarkedDrawdownPct:
      paperAutomation.maxMarkedDrawdownPctByQuote?.[book.symbol] || 0,
  });
  return {
    quote: book.symbol,
    ...book.portfolio.snapshot(),
    strategyVersion: PAPER_STRATEGY_VERSION,
    analytics: currentAnalytics,
    legacyAnalytics: analyzePaperTrades({
      initialCash: state.initialCash, trades: state.trades,
      openPositions: state.openPositions,
    }),
    recentTrades: state.trades.slice(-20),
  };
}

function currentLiveReadiness(operationalReady, books = null, shadow = null) {
  const currentBooks = books || Object.fromEntries([...paperBooks.values()].map((book) => [
    book.symbol, paperBookStatus(book),
  ]));
  const currentShadow = shadow || shadowEvaluator.snapshot();
  const escape = currentShadow.byRule?.["escape-activity"] || {};
  return assessLiveReadiness({
    paper: currentBooks.WETH.analytics,
    shadow: { uniquePools: escape.uniquePools, eligible: escape.promotion?.eligible },
    sellProbeReady: sellProbeReady(),
    walletConfigured: turnkeyStatus.authenticated && turnkeyStatus.addressMatch,
    turnkeyPolicyAttested: turnkeyStatus.readOnlyAttested === true,
    turnkeyPolicyVerified: turnkeyStatus.readOnlyVerified === true,
    rpcEndpointCount: rpcTransport.snapshot().endpointCount,
    operationalReady,
    evidenceJournalReady: evidenceJournal.snapshot().healthy,
    recoverySkippedBlocks: paperAutomation.recoverySkippedBlocks,
  });
}

function executionStatus(operationalReady, liveReadiness = null) {
  const readiness = liveReadiness || currentLiveReadiness(operationalReady);
  const executionState = { journal: executionJournal.snapshot() };
  const pendingExecutions = executionPendingCount(executionState);
  return {
    boundary: "review-only-disconnected",
    submissionPathConnected: false,
    automaticSubmissionEnabled: false,
    durability: {
      restored: persistence.restored,
      journalRecords: executionJournal.snapshot().records.length,
      pendingExecutions,
      nonceLaneCount: executionNonceLane.snapshot().lanes.length,
      spendIntentCount: executionSpendLedger.snapshot().intentIds.length,
    },
    config: publicMicroMainnetConfig(MICRO_MAINNET_CONFIG),
    signingVerification: {
      checked: turnkeySigningStatus.checked,
      verified: turnkeySigningStatus.verified,
      credentialVerified: turnkeySigningStatus.credentialVerified,
      apiKeyOwned: turnkeySigningStatus.apiKeyOwned,
      rootQuorumMember: turnkeySigningStatus.rootQuorumMember,
      expectedPolicySetExact: turnkeySigningStatus.expectedPolicySetExact,
      applicableAllowPolicyCount: turnkeySigningStatus.applicableAllowPolicyCount,
      attestationVerified: turnkeySigningStatus.attestationVerified,
      attestationExpiresAt: turnkeySigningStatus.attestationExpiresAt,
      walletBalanceVerified: turnkeySigningStatus.walletBalanceVerified,
      walletBalanceWithinDailyCap: turnkeySigningStatus.walletBalanceVerified
        && /^\d+$/.test(String(MICRO_MAINNET_CONFIG.maxDailyWei))
        && BigInt(turnkeySigningStatus.walletWethBalanceWei) <= BigInt(MICRO_MAINNET_CONFIG.maxDailyWei),
      failures: turnkeySigningStatus.failures,
      lastError: turnkeySigningStatus.lastError,
    },
    activation: assessMicroMainnetActivation({
      config: MICRO_MAINNET_CONFIG,
      liveReadiness: readiness,
      signingCredentialVerified: turnkeySigningStatus.credentialVerified,
      signingPolicyVerified: turnkeySigningStatus.verified,
      walletWethBalanceWei: turnkeySigningStatus.walletWethBalanceWei,
      pendingExecutions,
      submissionPathConnected: false,
    }),
  };
}

function paperStatus() {
  const books = Object.fromEntries([...paperBooks.values()].map((book) => [
    book.symbol, paperBookStatus(book),
  ]));
  const shadow = shadowEvaluator.snapshot();
  const operational = snapshot().readiness;
  const liveReadiness = currentLiveReadiness(operational.readyForPaper, books, shadow);
  return {
    mode: "PAPER_ONLY",
    newEntriesPaused: PAPER_ENTRIES_PAUSED,
    pauseReason: persistence.automationBlockedReason
      || (PAPER_ENTRIES_PAUSED ? "paper-ledger-review" : null),
    shadowRecordingPaused: SHADOW_RECORDING_PAUSED,
    passiveDislocationObservationPaused: DISLOCATION_OBSERVATION_PAUSED,
    automationBlockedReason: persistence.automationBlockedReason,
    books,
    archives: paperArchives.map((archive) => ({
      version: archive.version,
      archivedAt: archive.archivedAt,
      trades: Object.values(archive.books || {}).reduce(
        (total, book) => total + Number(book?.state?.trades?.length || 0), 0,
      ),
    })),
    automation: { ...paperAutomation, cycleIntervalMs: PAPER_CYCLE_MS,
      configuredCycleIntervalMs: PAPER_CYCLE_MS,
      observedCycleAverageMs: paperAutomation.cycles > 1
        ? (Number(paperAutomation.lastCycleAt) - Number(paperAutomation.firstCycleAt))
          / (paperAutomation.cycles - 1) : null,
      lastCycleAt: lastPaperCycleAt || null },
    evidence: evidenceJournal.snapshot(),
    gasMeasurement: GAS_MEASUREMENT,
    sellProbe: publicSellProbeStatus(),
    shadow,
    passiveDislocations: dislocationObserver.snapshot(),
    liveReadiness,
    execution: executionStatus(operational.readyForPaper, liveReadiness),
  };
}

async function dashboard() {
  const active = signals(10);
  const cards = [];
  for (const pool of active) {
    const [a, b] = await Promise.all([tokenMeta(pool.token0), tokenMeta(pool.token1)]);
    cards.push(`<article><b>${esc(a.symbol)}/${esc(b.symbol)}</b><span>${esc(pool.dex || "unknown")} · ${pool.version.toUpperCase()}${pool.fee ? ` · ${pool.fee / 10000}%` : ""} · ${esc(pool.signal.state)}</span><small>${esc(pool.address)} · score ${pool.signal.score} · ${pool.signal.swapsCurrentWindow} recent swaps · ${pool.signal.acceleration}× acceleration</small></article>`);
  }
  const s = snapshot();
  const paperNotice = PAPER_ENTRIES_PAUSED
    ? '<p class="warn">PAPER ENTRIES PAUSED<br>Shadow measurement continues.</p>'
    : '<p class="ok">PAPER SAMPLING ACTIVE<br>Virtual entries and exits are enabled.</p>';
  return `<!doctype html><meta name="viewport" content="width=device-width"><title>Atlas Trader</title><style>body{font:15px system-ui;background:#111827;color:#e5e7eb;margin:auto;max-width:720px;padding:18px}h1{font-size:23px}.warn{background:#713f12;padding:12px;border-radius:10px}.ok{background:#14532d;padding:12px;border-radius:10px}.grid,article{display:grid;gap:9px}section,article{background:#1f2937;margin:12px 0;padding:15px;border-radius:12px}article span,small{color:#9ca3af}code{color:#86efac}</style><h1>Atlas Trader</h1><p>Robinhood Chain adapter</p>${paperNotice}<section class="grid"><b>Chain <code>4663</code></b><span>Latest block: ${s.latestBlock.toLocaleString()}</span><span>Cursor: ${s.cursor.toLocaleString()}</span><span>Pools: ${pools.size} (${metrics.v2Pools} V2 / ${metrics.v3Pools} V3)</span><span>Swaps observed: ${metrics.swaps}</span><span>Polls: ${metrics.successfulPolls} successful / ${metrics.failedPolls} failed</span><span>Last error: ${esc(metrics.lastError || "none")}</span><span>Paper readiness: ${s.readiness.readyForPaper ? "ready" : esc(s.readiness.reasons.join(", "))}</span></section><h2>Most active pools</h2>${cards.join("") || "<section>Waiting for pool events in the observation window.</section>"}`;
}

function workerRequestAuthorized(req) {
  return workerObserverAuthorized(req.headers.authorization,
    LIVE_WORKER_OBSERVER_BEARER_TOKEN);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== "GET") { res.writeHead(405).end("Method Not Allowed"); return; }
    if (req.url === "/health") return json(res, { status: "ok", ...snapshot() });
    if (req.url === "/api/scanner") return json(res, snapshot());
    if (req.url === "/api/pools") return json(res, { total: pools.size, pools: [...pools.values()].slice(0, 100) });
    if (req.url === "/api/signals") return json(res, { mode: "PAPER_SIGNAL_ONLY", signals: signals() });
    if (req.url === "/api/candidates") return json(res, { mode: "PAPER_FAIL_CLOSED", candidates: await candidates() });
    if (req.url === "/api/paper") return json(res, paperStatus());
    if (req.url === "/api/live-worker/candidates" || req.url === "/api/live-worker/readiness") {
      if (!workerRequestAuthorized(req)) { res.writeHead(401).end("Unauthorized"); return; }
      if (req.url === "/api/live-worker/candidates") {
        return json(res, { mode: "PAPER_FAIL_CLOSED", candidates: await candidates() });
      }
      return json(res, paperStatus());
    }
    if (req.url === "/api/evidence") {
      if (!evidenceJournal.enabled) { res.writeHead(404).end("Evidence journal disabled"); return; }
      res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store" });
      createReadStream(evidenceJournal.path).pipe(res);
      return;
    }
    if (req.url === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(await dashboard()); return; }
    res.writeHead(404).end("Not Found");
  } catch (error) { res.writeHead(500).end("Internal Error"); }
});

function json(res, value) {
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

await blockIfExecutionRecoveryActive();
await initializeEvidenceJournal();
await restoreState();
await verifyConfiguredGasMeasurement();
await verifyTurnkeyConfiguration();
await verifySellProbeOverrideSupport();
server.listen(PORT, "0.0.0.0", () => console.log(`Read-only observer listening on ${PORT}`));
poll();
const gasVerificationTimer = setInterval(() => {
  void verifyConfiguredGasMeasurement();
}, GAS_VERIFICATION_INTERVAL_MS);
gasVerificationTimer.unref();
if (MICRO_MAINNET_CONFIG.requested) {
  const turnkeyVerificationTimer = setInterval(() => {
    void verifyTurnkeyConfiguration();
  }, GAS_VERIFICATION_INTERVAL_MS);
  turnkeyVerificationTimer.unref();
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await persistState(true);
  server.closeAllConnections?.();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
