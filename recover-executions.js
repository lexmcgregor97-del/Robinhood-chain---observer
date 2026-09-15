import { ExecutionRecovery } from "./execution-recovery.js";
import { withIsolatedExecutionState } from "./isolated-execution-state.js";

const CONFIRMATION = "RECONCILE_ATLAS_EXECUTIONS_OFFLINE";
const integer = (value, fallback) => {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("invalid-recovery-number");
  return parsed;
};

export async function runExecutionRecovery({ env = process.env, fetchImpl = fetch,
  now = Date.now(), output = () => {} } = {}) {
  if (env.EXECUTION_RECOVERY_CONFIRM !== CONFIRMATION) {
    throw new Error("execution-recovery-offline-confirmation-required");
  }
  const manualReviewAfterMs = integer(env.EXECUTION_MANUAL_REVIEW_AFTER_MS, 10 * 60_000);
  const isolated = await withIsolatedExecutionState({ env, fetchImpl, now }, async ({
    journal, nonceLane, expectedWalletAddress, transport,
  }) => {
    const recovery = new ExecutionRecovery({ journal, nonceLane, expectedWalletAddress,
      getReceipt: (transactionHash) => transport.request(
        "eth_getTransactionReceipt", [transactionHash],
      ) });
    return recovery.reconcile({ now: Number(now), manualReviewAfterMs });
  });
  const report = Object.freeze({ ...isolated.result,
    rpc: isolated.rpc, writeBlocked: isolated.writeBlocked });
  output(JSON.stringify(report));
  return report;
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  runExecutionRecovery({ output: (line) => console.log(line) }).then((result) => {
    if (!result.safeToRestart) process.exitCode = 2;
  }).catch((error) => {
    console.error(JSON.stringify({ status: "failed", failure: error.message }));
    process.exitCode = 1;
  });
}
