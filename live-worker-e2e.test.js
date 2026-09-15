import test from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, keccak256,
  parseTransaction } from "viem";
import { ExecutionJournal } from "./execution-journal.js";
import { NonceLane } from "./nonce-lane.js";
import { DailySpendLedger } from "./spend-ledger.js";
import { ExecutionLifecycle } from "./execution-lifecycle.js";
import { LivePositionLedger } from "./live-position-ledger.js";
import { LiveExecutionWorker } from "./live-execution-worker.js";
import { validateV2RouterCalldata, V2_ROUTER_ABI } from "./router-calldata.js";
import { validateApprovalCalldata, APPROVE_ABI } from "./approval-calldata.js";
import { TRANSFER_ABI } from "./live-position-settlement.js";

const account = privateKeyToAccount(`0x${"1".repeat(64)}`);
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

const transferLog = (token, amount) => ({ address: token,
  topics: encodeEventTopics({ abi: TRANSFER_ABI, eventName: "Transfer",
    args: { from: POOL, to: WALLET } }),
  data: encodeAbiParameters([{ type: "uint256" }], [amount]) });

test("walks candidate through buy, exact approval, stopped exit, and receipt settlement", async () => {
  let nonce = 0;
  let lastPayload;
  const provider = { getPendingNonce: async () => nonce++,
    sign: async (intent, { nonce: txNonce }) => {
      const payload = await account.signTransaction({ type: "eip1559", chainId: 4663,
        nonce: txNonce, to: intent.to, data: intent.data, value: 0n, gas: 100000n,
        maxFeePerGas: 2n, maxPriorityFeePerGas: 1n });
      lastPayload = payload;
      return { payload, transactionHash: keccak256(payload), gas: "100000",
        maxFeePerGas: "2", maxPriorityFeePerGas: "1" };
    }, broadcast: async (payload) => keccak256(payload),
    waitForReceipt: async (hash) => {
      const transaction = parseTransaction(lastPayload);
      let logs = [];
      try {
        const call = decodeFunctionData({ abi: V2_ROUTER_ABI, data: transaction.data });
        logs = [transferLog(call.args[2][0].toLowerCase() === WETH ? TOKEN : WETH,
          call.args[2][0].toLowerCase() === WETH ? 190n : 75n)];
      } catch {}
      return { status: "success", transactionHash: hash, from: WALLET,
        blockNumber: "0x2a", logs };
    }, getReceipt: async () => null };
  const journal = new ExecutionJournal();
  const nonceLane = new NonceLane();
  const spendLedger = new DailySpendLedger();
  const positions = new LivePositionLedger();
  const buyPolicy = { allowedChainIds: [4663], walletAddress: WALLET,
    maxExpiryMs: 60_000, maxValueWei: "0", allowedCalls: { [ROUTER]: ["0x38ed1739"] },
    spendLimits: { [WETH]: { maxPerTransaction: "1000", maxDaily: "1000" } },
    maxRouterDeadlineSeconds: 60 };
  const lifecycle = new ExecutionLifecycle({ policy: buyPolicy, ledger: spendLedger,
    journal, nonceLane, provider, preflight: async () => ({ approved: true }),
    validateCalldata: (intent, policy, context) => validateV2RouterCalldata(intent,
      { ...policy, allowedPaths: [[WETH, TOKEN]] }, context) });
  const auxiliary = (position, kind) => new ExecutionLifecycle({
    policy: { allowedChainIds: [4663], walletAddress: WALLET, maxExpiryMs: 60_000,
      maxValueWei: "0", allowedCalls: { [kind === "approval" ? TOKEN : ROUTER]:
        [kind === "approval" ? "0x095ea7b3" : "0x38ed1739"] },
      spendLimits: { [TOKEN]: { maxPerTransaction: "190", maxDaily: "1000" } },
      maxRouterDeadlineSeconds: 60 }, ledger: { snapshot: () => ({ spent: {} }),
      record: async () => {} }, journal, nonceLane, provider,
    preflight: async () => ({ approved: true }),
    validateCalldata: kind === "approval"
      ? (intent, policy) => validateApprovalCalldata(intent,
        { ...policy, allowedApprovalSpenders: [ROUTER],
          approvalLimits: { [TOKEN]: { maxAmount: "190" } } },
        { spender: ROUTER, amount: "190" })
      : (intent, policy, context) => validateV2RouterCalldata(intent,
        { ...policy, allowedPaths: [[TOKEN, WETH]] }, context) });
  let allowance = "0";
  const construction = { poolAddress: POOL, token0: WETH, token1: TOKEN,
    wethAddress: WETH, reserve0: "1000000", reserve1: "2000000", blockNumber: 42,
    strategyApproved: true, feeBps: 30 };
  const worker = new LiveExecutionWorker({ source: { fetchCandidates: async () => [{
    version: "v2", dex: "uniswap", address: POOL, token0: WETH, token1: TOKEN }] },
  inspectCandidate: async () => construction,
  inspectPosition: async () => ({ ...construction, reserve0: "800000",
    baseAllowanceWei: allowance }), lifecycle,
  submitApproval: async (intent, position, context) => {
    const result = await auxiliary(position, "approval").submit(intent, context);
    if (result.status === "confirmed") allowance = position.baseUnits;
    return result;
  }, submitExit: (intent, position, context) => auxiliary(position, "exit").submit(intent, context),
  probeExit: async () => ({ approved: true }), journal, positions, plans: new Map(), config });

  assert.equal((await worker.runOnce({ now: 1_000_000 })).result.status, "confirmed");
  assert.equal((await worker.runOnce({ now: 1_001_000 })).status, "approval-submitted");
  const exited = await worker.runOnce({ now: 1_002_000 });
  assert.equal(exited.status, "exit-submitted");
  assert.equal(exited.result.status, "confirmed");
  assert.equal(positions.openPositions().length, 0);
  assert.equal(positions.hasProcessed(exited.intentId), true);
});
