import { evaluateExecutionPolicy } from "./execution-policy.js";
import { validateV2RouterCalldata } from "./router-calldata.js";

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

export class ExecutionLifecycleError extends Error {
  constructor(stage, cause, state) {
    super(`execution-${stage}-failed: ${cause?.message || cause}`);
    this.name = "ExecutionLifecycleError";
    this.stage = stage;
    this.cause = cause;
    this.state = Object.freeze({ ...state, stage, status: "failed" });
  }
}

export class ExecutionLifecycle {
  constructor({ policy, ledger, journal, nonceLane, provider, validateCalldata = validateV2RouterCalldata }) {
    if (!policy || !ledger || !journal || !nonceLane || !provider || typeof validateCalldata !== "function") {
      throw new Error("invalid-execution-lifecycle-config");
    }
    this.policy = policy;
    this.ledger = ledger;
    this.journal = journal;
    this.nonceLane = nonceLane;
    this.provider = provider;
    this.validateCalldata = validateCalldata;
    this.running = new Set();
  }

  async submit(rawIntent, { now = Date.now() } = {}) {
    const normalizedAsset = String(rawIntent?.spendAsset || "").toLowerCase();
    const spent = this.ledger.snapshot(now).spent[normalizedAsset] || "0";
    const evaluated = evaluateExecutionPolicy(rawIntent, this.policy, { now, dailySpent: spent });
    if (!evaluated.approved) {
      return Object.freeze({ status: "rejected", stage: "policy", failures: evaluated.failures });
    }

    const { intent } = evaluated;
    if (this.running.has(intent.id)) {
      return Object.freeze({ status: "rejected", stage: "replay", failures: ["duplicate-intent"] });
    }
    const calldata = this.validateCalldata(intent, this.policy, { nowSeconds: Math.floor(now / 1000) });
    if (!calldata.approved) {
      return Object.freeze({ status: "rejected", stage: "calldata", failures: calldata.failures });
    }

    this.running.add(intent.id);
    const state = { intentId: intent.id, status: "pending", stage: "reserved", transactionHash: null };
    try {
      this.ledger.record({
        intentId: intent.id, asset: intent.spendAsset, amount: intent.spendAmount,
      }, now);
      await this.journal.transition(intent.id, {
        status: "reserved", chainId: intent.chainId,
        spendAsset: intent.spendAsset, spendAmount: intent.spendAmount,
      }, now);
    } catch (error) {
      this.running.delete(intent.id);
      return Object.freeze({ status: "rejected", stage: "reservation", failures: [error.message] });
    }

    try {
      state.stage = "signing";
      const nonce = await this.nonceLane.reserve({
        chainId: intent.chainId, walletAddress: intent.from, intentId: intent.id,
      }, () => this.provider.getPendingNonce(intent));
      await this.journal.transition(intent.id, { status: "nonce-reserved", nonce }, now);
      const signed = await this.provider.sign(intent, { nonce });
      if (!signed || !TX_HASH.test(String(signed.transactionHash))) {
        throw new Error("signed-transaction-hash-required");
      }
      state.transactionHash = signed.transactionHash.toLowerCase();
      await this.journal.transition(intent.id, {
        status: "signed", transactionHash: state.transactionHash,
      }, now);
      state.stage = "broadcasting";
      const transactionHash = String(await this.provider.broadcast(signed.payload, intent)).toLowerCase();
      if (transactionHash !== state.transactionHash) throw new Error("broadcast-hash-mismatch");
      await this.journal.transition(intent.id, { status: "broadcast" }, now);
      state.stage = "confirming";
      const receipt = await this.provider.waitForReceipt(state.transactionHash, intent);
      const succeeded = receipt?.status === "success" || receipt?.status === 1 || receipt?.status === "0x1";
      const status = succeeded ? "confirmed" : "reverted";
      await this.journal.transition(intent.id, { status, receipt }, now);
      await this.nonceLane.finalize(intent.id);
      return Object.freeze({ ...state, stage: "confirmed", status, receipt });
    } catch (error) {
      throw new ExecutionLifecycleError(state.stage, error, state);
    } finally {
      this.running.delete(intent.id);
    }
  }

  async recoverPending({ now = Date.now() } = {}) {
    const outcomes = [];
    for (const record of this.journal.pending()) {
      if (!record.transactionHash) {
        outcomes.push(Object.freeze({ ...record, recovery: "manual-review" }));
        continue;
      }
      try {
        const receipt = await this.provider.getReceipt(record.transactionHash);
        if (!receipt) {
          outcomes.push(Object.freeze({ ...record, recovery: "still-pending" }));
          continue;
        }
        const succeeded = receipt.status === "success" || receipt.status === 1 || receipt.status === "0x1";
        const status = succeeded ? "confirmed" : "reverted";
        await this.journal.transition(record.intentId, { status, receipt }, now);
        await this.nonceLane.finalize(record.intentId);
        outcomes.push(Object.freeze({ ...record, status, receipt, recovery: "reconciled" }));
      } catch (error) {
        outcomes.push(Object.freeze({ ...record, recovery: "rpc-error", error: error.message }));
      }
    }
    return outcomes;
  }
}
