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
import { validateV2RouterCalldata, V2_ROUTER_ABI } from "./router-calldata.js";
import { validateApprovalCalldata, APPROVE_ABI } from "./approval-calldata.js";
import { TRANSFER_ABI } from "./live-position-settlement.js";
import { assessLiveExitPreflight } from "./live-exit-preflight.js";

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

function simulatedProvider({ receiptStatuses = [] } = {}) {
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
      return { status: receiptStatuses.shift() || "success", transactionHash, from: WALLET,
        blockNumber: "0x2a", logs };
    }, getReceipt: async () => null };
}

const buyPolicy = { allowedChainIds: [4663], walletAddress: WALLET,
  maxExpiryMs: 60_000, maxValueWei: "0", allowedCalls: { [ROUTER]: ["0x38ed1739"] },
  spendLimits: { [WETH]: { maxPerTransaction: "1000", maxDaily: "1000" } },
  maxRouterDeadlineSeconds: 60 };

function lifecycle(store, provider, kind = "buy", preflight = async () => ({ approved: true })) {
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
    preflight, validateCalldata });
}

function worker(store, provider, chainState) {
  return new LiveExecutionWorker({ source: { fetchCandidates: async () => [] },
    inspectCandidate: async () => snapshot,
    inspectPosition: async () => ({ ...snapshot, reserve0: "800000",
      baseAllowanceWei: chainState.allowance }),
    lifecycle: lifecycle(store, provider),
    submitApproval: async (intent, position, context) => {
      const result = await lifecycle(store, provider, "approval").submit(intent, context);
      if (result.status === "confirmed") chainState.allowance = decodeFunctionData({
        abi: APPROVE_ABI, data: intent.data }).args[1].toString();
      return result;
    },
    submitExit: async (intent, position, context) => {
      if (chainState.failExit) throw new Error("rehearsal-crash-before-exit-submit");
      const result = await lifecycle(store, provider, "sell").submit(intent, context);
      return chainState.deferSettlement ? { ...result, status: "broadcast" } : result;
    }, probeExit: async () => ({ approved: true }),
    journal: store.journal, positions: store.livePositions, plans: new Map(), config });
}

test("disabled rehearsal survives every durable buy-to-exit boundary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-disabled-rehearsal-"));
  const statePath = join(directory, "worker.json");
  const evidencePath = join(directory, "worker.jsonl");
  const provider = simulatedProvider();
  const chainState = { allowance: "7", failExit: false, deferSettlement: false };
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
    await worker(store, provider, chainState).reconcilePositions(901_000);
    assert.equal(store.livePositions.openPositions()[0].baseUnits, "190");

    // Boundary 2: the exact receipt-derived position survives before allowance handling.
    store = await reopen();
    assert.equal(store.livePositions.openPositions()[0].baseUnits, "190");
    const reset = await worker(store, provider, chainState).runOnce({ now: 902_000 });
    assert.equal(reset.status, "approval-submitted");
    assert.equal(store.journal.get(reset.intentId).intentPurpose, "live-exit-approval-reset");
    assert.equal(chainState.allowance, "0");

    // Boundary 3: a zero-reset receipt survives before the exact approval.
    store = await reopen();
    assert.equal(store.journal.get(reset.intentId).status, "confirmed");
    const exact = await worker(store, provider, chainState).runOnce({ now: 903_000 });
    assert.equal(exact.status, "approval-submitted");
    assert.equal(store.journal.get(exact.intentId).intentPurpose, "live-exit-approval");
    assert.equal(chainState.allowance, "190");

    // Boundary 4: exact approval and the exit request are both durable before the sell.
    store = await reopen();
    assert.equal(store.journal.get(exact.intentId).status, "confirmed");
    chainState.failExit = true;
    await assert.rejects(worker(store, provider, chainState).runOnce({ now: 904_000 }),
      /rehearsal-crash-before-exit-submit/);
    const firstExitId = store.livePositions.get(POOL).exitIntentId;
    store = await reopen();
    assert.equal(store.livePositions.get(POOL).status, "exit-requested");
    assert.equal(store.journal.get(firstExitId), null);
    chainState.failExit = false;
    chainState.deferSettlement = true;
    const sell = await worker(store, provider, chainState).runOnce({ now: 905_000 });
    assert.equal(sell.status, "exit-submitted");
    assert.equal(store.journal.get(sell.intentId).status, "confirmed");

    // Boundary 5: the sell receipt is durable but position closure is repaired after restart.
    store = await reopen();
    assert.equal(store.livePositions.openPositions().length, 1);
    await worker(store, provider, chainState).reconcilePositions(906_000);
    assert.equal(store.livePositions.openPositions().length, 0);
    assert.equal(store.livePositions.hasProcessed(sell.intentId), true);
    assert.equal(store.livePositions.snapshot().history.at(-1).wethReceivedWei, "75");
    assert.equal(store.evidence.snapshot().healthy, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("real exit preflight blocks an off-by-one allowance before signing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-rehearsal-preflight-"));
  try {
    const store = await openLiveExecutionStore({ statePath: join(directory, "worker.json"),
      evidencePath: join(directory, "worker.jsonl"), lockPresent: async () => false });
    const position = { poolAddress: POOL, baseToken: TOKEN, routerAddress: ROUTER,
      baseUnits: "190", entryWethWei: "100", peakWethOutWei: "100", feeBps: 30,
      entryIntentId: "buy:preflight", entryTransactionHash: `0x${"1".repeat(64)}`,
      openedAt: 1, status: "open" };
    const sell = buildLiveV2SellIntent({ position, snapshot: { ...snapshot,
      reserve0: "800000", blockNumber: 44 }, config, slippageBps: 100,
    deadlineSeconds: 60, now: 1_000_000 });
    let signed = false;
    const provider = simulatedProvider();
    const originalSign = provider.sign;
    provider.sign = async (...args) => { signed = true; return originalSign(...args); };
    const preflight = async (intent) => assessLiveExitPreflight({ intent, position,
      chain: { ...snapshot, reserve0: "800000", blockNumber: 44, latestBlock: 44,
        observedAt: 1_000_000, blockTimestampMs: 1_000_000,
        baseBalanceWei: "190", baseAllowanceWei: "189" },
      signing: { credentialVerified: true, policyVerified: true }, simulationPassed: true,
      now: 1_000_000 });
    const result = await lifecycle(store, provider, "sell", preflight)
      .submit(sell, { now: 1_000_000 });
    assert.equal(result.status, "rejected");
    assert.equal(signed, false);
    assert.ok(result.failures.includes("live-base-allowance-not-exact"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a reverted sell reopens the position and a later retry can settle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-rehearsal-revert-"));
  try {
    const store = await openLiveExecutionStore({ statePath: join(directory, "worker.json"),
      evidencePath: join(directory, "worker.jsonl"), lockPresent: async () => false });
    await store.livePositions.open({ poolAddress: POOL, baseToken: TOKEN, routerAddress: ROUTER,
      baseUnits: "190", entryWethWei: "100", feeBps: 30, entryIntentId: "buy:revert",
      entryTransactionHash: `0x${"2".repeat(64)}`, openedAt: 1 }, 1);
    const provider = simulatedProvider({ receiptStatuses: ["reverted", "success"] });
    const chainState = { allowance: "190", failExit: false, deferSettlement: false };
    const first = await worker(store, provider, chainState).runOnce({ now: 1_000_000 });
    assert.equal(first.result.status, "reverted");
    assert.equal(store.livePositions.get(POOL).status, "exit-requested");
    const second = await worker(store, provider, chainState).runOnce({ now: 1_001_000 });
    assert.equal(second.result.status, "confirmed", JSON.stringify(second));
    assert.equal(store.livePositions.openPositions().length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
