import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, keccak256,
  parseTransaction } from "viem";
import { openLiveExecutionStore } from "./live-execution-store.js";
import { ExecutionLifecycle } from "./execution-lifecycle.js";
import { LiveExecutionWorker } from "./live-execution-worker.js";
import { buildLiveV2BuyIntent, buildLiveV2SellIntent } from "./live-v2-intent.js";
import { buildLiveExitApprovalIntent } from "./live-approval-intent.js";
import { validateV2RouterCalldata, V2_ROUTER_ABI } from "./router-calldata.js";
import { validateApprovalCalldata, APPROVE_ABI } from "./approval-calldata.js";
import { TRANSFER_ABI } from "./live-position-settlement.js";

const account = privateKeyToAccount(`0x${"2".repeat(64)}`);
const WALLET = account.address;
const WETH = "0x0000000000000000000000000000000000000001";
const TOKEN = "0x0000000000000000000000000000000000000002";
const POOL = "0x0000000000000000000000000000000000000003";
const ROUTER = "0x0000000000000000000000000000000000000004";
const config = { chainId: 4663, walletAddress: WALLET, wethAddress: WETH,
  allowedRouters: [ROUTER], routerAddress: ROUTER, maxPerTransactionWei: "1000",
  amountInWei: "100", slippageBps: 100, deadlineSeconds: 60,
  exitPolicy: { stopLossPct: 8, takeProfitPct: 35, trailingActivationPct: 10,
    trailingDrawdownPct: 6, maxHoldMs: 1_000_000 } };
const snapshot = { poolAddress: POOL, token0: WETH, token1: TOKEN, wethAddress: WETH,
  reserve0: "1000000", reserve1: "2000000", blockNumber: 42,
  discoveryBlock: 1, strategyApproved: true, feeBps: 30, baseAllowanceWei: "7" };

const transferLog = (token, amount) => ({ address: token,
  topics: encodeEventTopics({ abi: TRANSFER_ABI, eventName: "Transfer",
    args: { from: POOL, to: WALLET } }),
  data: encodeAbiParameters([{ type: "uint256" }], [amount]) });

function simulatedProvider() {
  let nonce = 0;
  const payloads = new Map();
  return { getPendingNonce: async () => nonce++,
    sign: async (intent, { nonce: transactionNonce }) => {
      const payload = await account.signTransaction({ type: "eip1559", chainId: 4663,
        nonce: transactionNonce, to: intent.to, data: intent.data, value: 0n, gas: 100000n,
        maxFeePerGas: 2n, maxPriorityFeePerGas: 1n });
      const transactionHash = keccak256(payload);
      payloads.set(transactionHash, payload);
      return { payload, transactionHash, gas: "100000", maxFeePerGas: "2",
        maxPriorityFeePerGas: "1" };
    }, broadcast: async (payload) => keccak256(payload),
    waitForReceipt: async (transactionHash) => {
      const transaction = parseTransaction(payloads.get(transactionHash));
      let logs = [];
      try {
        const call = decodeFunctionData({ abi: V2_ROUTER_ABI, data: transaction.data });
        const buying = call.args[2][0].toLowerCase() === WETH;
        logs = [transferLog(buying ? TOKEN : WETH, buying ? 190n : 75n)];
      } catch {}
      return { status: "success", transactionHash, from: WALLET,
        blockNumber: "0x2a", logs };
    }, getReceipt: async () => null };
}

const buyPolicy = { allowedChainIds: [4663], walletAddress: WALLET,
  maxExpiryMs: 60_000, maxValueWei: "0", allowedCalls: { [ROUTER]: ["0x38ed1739"] },
  spendLimits: { [WETH]: { maxPerTransaction: "1000", maxDaily: "1000" } },
  maxRouterDeadlineSeconds: 60 };

function lifecycle(store, provider, kind = "buy") {
  const approval = kind === "approval";
  const amount = "190";
  const policy = approval || kind === "sell" ? { allowedChainIds: [4663],
    walletAddress: WALLET, maxExpiryMs: 60_000, maxValueWei: "0",
    allowedCalls: { [approval ? TOKEN : ROUTER]:
      [approval ? "0x095ea7b3" : "0x38ed1739"] },
    spendLimits: { [TOKEN]: { maxPerTransaction: amount, trackDaily: false } },
    recordSpend: false, maxRouterDeadlineSeconds: 60 } : buyPolicy;
  const validateCalldata = approval
    ? (intent, checkedPolicy) => validateApprovalCalldata(intent,
      { ...checkedPolicy, allowedApprovalSpenders: [ROUTER],
        approvalLimits: { [TOKEN]: { maxAmount: amount } } },
      { spender: ROUTER, amount: intent.purpose === "live-exit-approval-reset" ? "0" : amount,
        allowZero: intent.purpose === "live-exit-approval-reset" })
    : (intent, checkedPolicy, context) => validateV2RouterCalldata(intent,
      { ...checkedPolicy, allowedPaths: [kind === "buy" ? [WETH, TOKEN] : [TOKEN, WETH]] },
      context);
  return new ExecutionLifecycle({ policy, ledger: store.spendLedger,
    journal: store.journal, nonceLane: store.nonceLane, provider,
    preflight: async () => ({ approved: true }), validateCalldata });
}

function worker(store, provider) {
  return new LiveExecutionWorker({ source: { fetchCandidates: async () => [] },
    inspectCandidate: async () => snapshot, inspectPosition: async () => snapshot,
    lifecycle: lifecycle(store, provider),
    submitApproval: (intent, position, context) => lifecycle(store, provider, "approval")
      .submit(intent, context),
    submitExit: (intent, position, context) => lifecycle(store, provider, "sell")
      .submit(intent, context), probeExit: async () => ({ approved: true }),
    journal: store.journal, positions: store.livePositions, plans: new Map(), config });
}

test("disabled rehearsal survives every durable buy-to-exit boundary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-disabled-rehearsal-"));
  const statePath = join(directory, "worker.json");
  const evidencePath = join(directory, "worker.jsonl");
  const provider = simulatedProvider();
  const reopen = () => openLiveExecutionStore({ statePath, evidencePath,
    now: () => 1_000_000, lockPresent: async () => false });
  try {
    let store = await reopen();
    const buy = buildLiveV2BuyIntent({ candidate: { version: "v2", dex: "uniswap",
      address: POOL, token0: WETH, token1: TOKEN, discoveryBlock: 1, router: ROUTER }, snapshot,
    config, amountInWei: "100", slippageBps: 100, deadlineSeconds: 60, now: 900_000 });
    assert.equal((await lifecycle(store, provider).submit(buy, { now: 900_000 })).status, "confirmed");

    // Boundary 1: the buy receipt is durable but the position has not yet been opened.
    store = await reopen();
    assert.equal(store.livePositions.openPositions().length, 0);
    await worker(store, provider).reconcilePositions(901_000);
    assert.equal(store.livePositions.openPositions()[0].baseUnits, "190");

    // Boundary 2: the exact receipt-derived position survives before allowance handling.
    store = await reopen();
    const position = store.livePositions.openPositions()[0];
    assert.equal(position.baseUnits, "190");
    const reset = buildLiveExitApprovalIntent({ position, snapshot, config,
      amountWei: "0", now: 902_000 });
    assert.equal((await lifecycle(store, provider, "approval")
      .submit(reset, { now: 902_000 })).status, "confirmed");

    // Boundary 3: a zero-reset receipt survives before the exact approval.
    store = await reopen();
    assert.equal(store.journal.get(reset.id).status, "confirmed");
    const exact = buildLiveExitApprovalIntent({ position, snapshot: { ...snapshot, blockNumber: 43 },
      config, amountWei: "190", now: 903_000 });
    assert.equal((await lifecycle(store, provider, "approval")
      .submit(exact, { now: 903_000 })).status, "confirmed");

    // Boundary 4: exact approval and the exit request are both durable before the sell.
    store = await reopen();
    assert.equal(store.journal.get(exact.id).status, "confirmed");
    const marked = await store.livePositions.mark(POOL, "75", 904_000);
    const sell = buildLiveV2SellIntent({ position: marked, snapshot: { ...snapshot,
      reserve0: "800000", blockNumber: 44 }, config, slippageBps: 100,
    deadlineSeconds: 60, now: 904_000 });
    await store.livePositions.requestExit(POOL, { reason: "stop-loss", intentId: sell.id }, 904_000);
    store = await reopen();
    assert.equal(store.livePositions.get(POOL).status, "exit-requested");
    assert.equal((await lifecycle(store, provider, "sell")
      .submit(sell, { now: 905_000 })).status, "confirmed");

    // Boundary 5: the sell receipt is durable but position closure is repaired after restart.
    store = await reopen();
    assert.equal(store.livePositions.openPositions().length, 1);
    await worker(store, provider).reconcilePositions(906_000);
    assert.equal(store.livePositions.openPositions().length, 0);
    assert.equal(store.livePositions.hasProcessed(sell.id), true);
    assert.equal(store.livePositions.snapshot().history.at(-1).wethReceivedWei, "75");
    assert.equal(store.evidence.snapshot().healthy, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
