import { open, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { EvidenceJournal } from "./evidence-journal.js";
import { validateEvidenceCheckpoint } from "./evidence-checkpoint.js";
import { ExecutionJournal } from "./execution-journal.js";
import { NonceLane } from "./nonce-lane.js";
import { DailySpendLedger } from "./spend-ledger.js";
import { createExecutionMutationSerializer } from "./execution-mutation-queue.js";
import { ExecutionRecovery } from "./execution-recovery.js";
import { ExecutionManualReviewResolver } from "./execution-manual-review.js";
import {
  executionRecoveryLockPath,
} from "./execution-recovery-lock.js";
import { forbiddenRuntimeSecretFailures } from "./micro-mainnet-config.js";
import { RpcTransport, rpcUrlsFromEnv } from "./rpc-transport.js";
import { loadJsonState, saveJsonState } from "./state-store.js";
import { ROBINHOOD } from "./chain-config.js";
import { Turnkey } from "@turnkey/sdk-server";
import { turnkeyConfigFromEnv, probeTurnkeyPolicy } from "./turnkey-probe.js";
import { restoreUniqueAmbiguousSigningActivity } from "./turnkey-ambiguous-signing-recovery.js";

const CONFIRMATION = "RECONCILE_ATLAS_EXECUTIONS_OFFLINE";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const integer = (value, fallback) => {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("invalid-recovery-number");
  return parsed;
};

export async function runExecutionRecovery({ env = process.env, fetchImpl = fetch,
  now = Date.now(), output = () => {}, makeTurnkeyClient } = {}) {
  if (env.EXECUTION_RECOVERY_CONFIRM !== CONFIRMATION) {
    throw new Error("execution-recovery-offline-confirmation-required");
  }
  if (forbiddenRuntimeSecretFailures(env).length) {
    throw new Error("execution-recovery-private-material-forbidden");
  }
  const statePath = String(env.STATE_FILE || "");
  if (!statePath) throw new Error("execution-recovery-state-file-required");
  const expectedWalletAddress = String(
    env.TURNKEY_WALLET_ADDRESS || env.TURNKEY_SIGNING_WALLET_ADDRESS || "",
  ).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(expectedWalletAddress)) {
    throw new Error("execution-recovery-wallet-address-required");
  }
  const minimumStateAgeMs = integer(env.EXECUTION_RECOVERY_MIN_STATE_AGE_MS, 60_000);
  const manualReviewAfterMs = integer(env.EXECUTION_MANUAL_REVIEW_AFTER_MS, 10 * 60_000);
  const state = await loadJsonState(statePath);
  if (!state?.paperStrategyVersion) throw new Error("execution-recovery-state-invalid");
  if (Number(now) - Number(state.savedAt) < minimumStateAgeMs) {
    throw new Error("execution-runtime-may-still-be-running");
  }
  const evidenceDir = String(env.EVIDENCE_DIR || join(dirname(statePath), "evidence"));
  const evidence = new EvidenceJournal(join(evidenceDir, `${state.paperStrategyVersion}.jsonl`));
  await evidence.initialize();
  validateEvidenceCheckpoint({ state, journal: evidence.snapshot() });

  const lockPath = executionRecoveryLockPath(statePath);
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
    await lock.writeFile(JSON.stringify({ startedAt: Number(now), pid: process.pid }));
    await lock.sync();
  } catch (error) {
    if (lock) {
      await lock.close().catch(() => {});
      await unlink(lockPath).catch(() => {});
    }
    if (error?.code === "EEXIST") throw new Error("execution-recovery-already-running");
    throw error;
  }

  try {
    const urls = rpcUrlsFromEnv({ primary: env.RPC_URL,
      fallbacks: env.RPC_FALLBACK_URLS, defaultUrl: ROBINHOOD.rpcUrl });
    const transport = new RpcTransport({ urls, fetchImpl });
    const chainId = Number(BigInt(await transport.request("eth_chainId", [])));
    if (chainId !== ROBINHOOD.chainId) throw new Error("execution-recovery-chain-mismatch");

    const serialize = createExecutionMutationSerializer();
    let writeBlocked = false;
    let journal;
    let nonceLane;
    let spendLedger;
    const persist = async (_snapshot, event) => {
      if (writeBlocked) throw new Error("execution-recovery-write-blocked");
      try {
        const onDisk = await loadJsonState(statePath);
        const observedEvidence = new EvidenceJournal(evidence.path);
        await observedEvidence.initialize();
        const observedEvidenceSnapshot = observedEvidence.snapshot();
        if (!onDisk || onDisk.savedAt !== state.savedAt
            || Number(onDisk.evidenceSequence || 0) !== evidence.snapshot().sequence
            || String(onDisk.evidenceLastHash || "") !== String(evidence.snapshot().lastHash || "")
            || observedEvidenceSnapshot.sequence !== evidence.snapshot().sequence
            || observedEvidenceSnapshot.lastHash !== evidence.snapshot().lastHash) {
          throw new Error("execution-recovery-concurrent-runtime-detected");
        }
        await evidence.append({ epoch: state.paperStrategyVersion,
          recordedAt: Number(now), chainBlock: Number(state.cursor || 0), ...event });
        state.execution = { journal: journal.snapshot(), nonceLane: nonceLane.snapshot(),
          spendLedger: spendLedger.snapshot(Number(now)) };
        state.evidenceSequence = evidence.snapshot().sequence;
        state.evidenceLastHash = evidence.snapshot().lastHash;
        await saveJsonState(statePath, state);
        const checkpoint = await loadJsonState(statePath);
        state.savedAt = checkpoint.savedAt;
      } catch (error) {
        writeBlocked = true;
        throw error;
      }
    };
    journal = new ExecutionJournal(state.execution?.journal, { persist, serialize });
    nonceLane = new NonceLane(state.execution?.nonceLane, { persist, serialize });
    spendLedger = new DailySpendLedger(state.execution?.spendLedger, { persist, serialize });
    const preExistingManualReviewIds = new Set(journal.pending()
      .filter((record) => record.status === "manual-review")
      .map((record) => record.intentId));
    for (const record of journal.pending()) {
      if (Number(record.chainId) !== chainId) throw new Error("execution-record-chain-mismatch");
    }
    const recovery = new ExecutionRecovery({ journal, nonceLane,
      expectedWalletAddress,
      getReceipt: (transactionHash) => transport.request("eth_getTransactionReceipt", [transactionHash]) });
    const result = await recovery.reconcile({ now: Number(now), manualReviewAfterMs });
    let operatorResolution = null;
    const resolutionIntentId = String(env.EXECUTION_MANUAL_REVIEW_INTENT_ID || "");
    if (resolutionIntentId) {
      if (!preExistingManualReviewIds.has(resolutionIntentId)) {
        throw new Error("manual-review-label-not-yet-durable");
      }
      const resolver = new ExecutionManualReviewResolver({ journal, nonceLane });
      if (env.EXECUTION_MANUAL_REVIEW_CONFIRM
          === "RESTORE_ATLAS_SIGNED_TRANSACTION_FROM_TURNKEY") {
        const observer = turnkeyConfigFromEnv(env);
        const signingUserId = String(env.TURNKEY_SIGNING_USER_ID || "");
        const maxGas = String(env.MICRO_MAINNET_MAX_GAS || "");
        const maxFeePerGasWei = String(env.MICRO_MAINNET_MAX_FEE_PER_GAS_WEI || "");
        const activityMaxPages = String(env.TURNKEY_ACTIVITY_MAX_PAGES || "");
        if (!observer.configured || !observer.identifiersValid
            || !UUID.test(signingUserId)
            || !/^[1-9][0-9]*$/.test(maxGas)
            || !/^[1-9][0-9]*$/.test(maxFeePerGasWei)
            || !/^[1-9][0-9]*$/.test(activityMaxPages)
            || !Number.isSafeInteger(Number(activityMaxPages))) {
          throw new Error("ambiguous-signing-observer-config-invalid");
        }
        const factory = makeTurnkeyClient || ((config) => new Turnkey({
          apiBaseUrl: "https://api.turnkey.com",
          defaultOrganizationId: config.organizationId,
          apiPublicKey: config.apiPublicKey,
          apiPrivateKey: config.apiPrivateKey,
        }).apiClient());
        const client = factory(observer.config);
        const [observerPolicy, observerIdentity] = await Promise.all([
          probeTurnkeyPolicy({ config: observer.config,
            getWhoami: (request) => client.getWhoami(request),
            getOrganizationConfigs: (request) => client.getOrganizationConfigs(request),
            getPolicies: (request) => client.getPolicies(request),
            getUser: (request) => client.getUser(request) }),
          client.getWhoami({ organizationId: observer.config.organizationId }),
        ]);
        if (!observerPolicy.readOnlyVerified || !UUID.test(String(observerIdentity?.userId || ""))
            || observerIdentity.userId === signingUserId) {
          throw new Error("ambiguous-signing-observer-boundary-invalid");
        }
        const record = journal.get(resolutionIntentId);
        operatorResolution = await restoreUniqueAmbiguousSigningActivity({ record, resolver,
          getActivities: (request) => client.getActivities(request),
          getActivity: (request) => client.getActivity(request),
          evidenceConfig: { organizationId: observer.config.organizationId,
            walletAddress: expectedWalletAddress, signingUserId, maxGas, maxFeePerGasWei },
          operatorAssertion: env.EXECUTION_MANUAL_REVIEW_CONFIRM, now: Number(now),
          maxPages: Number(activityMaxPages) });
      } else {
        operatorResolution = await resolver.rejectNeverSigned(resolutionIntentId, {
          now: Number(now),
          operatorAssertion: env.EXECUTION_MANUAL_REVIEW_CONFIRM,
        });
      }
    }
    validateEvidenceCheckpoint({ state, journal: evidence.snapshot() });
    const report = Object.freeze({ ...result,
      pendingExecutions: journal.pending().length,
      operatorResolution,
      rpc: transport.snapshot(), writeBlocked });
    output(JSON.stringify(report));
    return report;
  } finally {
    await lock.close();
    await unlink(lockPath).catch(() => {});
  }
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  runExecutionRecovery({ output: (line) => console.log(line) }).then((result) => {
    if (!result.safeToRestart) process.exitCode = 2;
  }).catch((error) => {
    console.error(JSON.stringify({ status: "failed", failure: error.message }));
    process.exitCode = 1;
  });
}
