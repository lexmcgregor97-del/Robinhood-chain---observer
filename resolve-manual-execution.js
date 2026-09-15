import { ExecutionManualReview } from "./execution-manual-review.js";
import { withIsolatedExecutionState } from "./isolated-execution-state.js";

const ACTIONS = new Set(["reject-unsigned", "rebroadcast-identical", "prove-nonce-cancel"]);

export async function runManualExecutionResolution({ env = process.env,
  fetchImpl = fetch, now = Date.now(), output = () => {} } = {}) {
  const action = String(env.EXECUTION_MANUAL_REVIEW_ACTION || "");
  const intentId = String(env.EXECUTION_MANUAL_REVIEW_INTENT_ID || "");
  const confirmation = String(env.EXECUTION_MANUAL_REVIEW_CONFIRM || "");
  const replacementHash = String(env.EXECUTION_MANUAL_REVIEW_REPLACEMENT_TX_HASH || "");
  if (!ACTIONS.has(action)) throw new Error("execution-manual-review-action-invalid");
  if (!intentId) throw new Error("execution-manual-review-intent-required");

  const isolated = await withIsolatedExecutionState({ env, fetchImpl, now }, async ({
    chainId, expectedWalletAddress, journal, nonceLane, transport,
  }) => {
    const resolver = new ExecutionManualReview({ journal, nonceLane,
      expectedWalletAddress, chainId,
      broadcast: (payload) => transport.request("eth_sendRawTransaction", [payload]),
      getTransaction: (hash) => transport.request("eth_getTransactionByHash", [hash]),
      getReceipt: (hash) => transport.request("eth_getTransactionReceipt", [hash]),
    });
    if (action === "reject-unsigned") {
      return resolver.rejectUnsigned(intentId, { confirmation, now: Number(now) });
    }
    if (action === "rebroadcast-identical") {
      return resolver.rebroadcastIdentical(intentId, { confirmation, now: Number(now) });
    }
    return resolver.proveNonceCancel(intentId, replacementHash,
      { confirmation, now: Number(now) });
  });
  const report = Object.freeze({ ...isolated.result,
    rpc: isolated.rpc, writeBlocked: isolated.writeBlocked });
  output(JSON.stringify(report));
  return report;
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  runManualExecutionResolution({ output: (line) => console.log(line) }).catch((error) => {
    console.error(JSON.stringify({ status: "failed", failure: error.message }));
    process.exitCode = 1;
  });
}
