import { open, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { EvidenceJournal } from "./evidence-journal.js";
import { validateEvidenceCheckpoint } from "./evidence-checkpoint.js";
import { ExecutionJournal } from "./execution-journal.js";
import { NonceLane } from "./nonce-lane.js";
import { DailySpendLedger } from "./spend-ledger.js";
import { createExecutionMutationSerializer } from "./execution-mutation-queue.js";
import { executionRecoveryLockPath } from "./execution-recovery-lock.js";
import { forbiddenRuntimeSecretFailures } from "./micro-mainnet-config.js";
import { RpcTransport, rpcUrlsFromEnv } from "./rpc-transport.js";
import { loadJsonState, saveJsonState } from "./state-store.js";
import { ROBINHOOD } from "./chain-config.js";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const integer = (value, fallback) => {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("invalid-recovery-number");
  return parsed;
};

export async function withIsolatedExecutionState({ env = process.env,
  fetchImpl = fetch, now = Date.now() } = {}, operation) {
  if (typeof operation !== "function") throw new Error("isolated-execution-operation-required");
  if (forbiddenRuntimeSecretFailures(env).length) {
    throw new Error("execution-recovery-private-material-forbidden");
  }
  const statePath = String(env.STATE_FILE || "");
  if (!statePath) throw new Error("execution-recovery-state-file-required");
  const expectedWalletAddress = String(
    env.TURNKEY_WALLET_ADDRESS || env.TURNKEY_SIGNING_WALLET_ADDRESS || "",
  ).toLowerCase();
  if (!ADDRESS.test(expectedWalletAddress)) {
    throw new Error("execution-recovery-wallet-address-required");
  }
  const minimumStateAgeMs = integer(env.EXECUTION_RECOVERY_MIN_STATE_AGE_MS, 60_000);
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
    for (const record of journal.pending()) {
      if (Number(record.chainId) !== chainId) throw new Error("execution-record-chain-mismatch");
    }
    const result = await operation(Object.freeze({
      chainId, expectedWalletAddress, journal, nonceLane, spendLedger, transport,
    }));
    validateEvidenceCheckpoint({ state, journal: evidence.snapshot() });
    return Object.freeze({ result, rpc: transport.snapshot(), writeBlocked });
  } finally {
    await lock.close();
    await unlink(lockPath).catch(() => {});
  }
}
