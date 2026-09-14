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
  constructor({ policy, ledger, provider, validateCalldata = validateV2RouterCalldata }) {
    if (!policy || !ledger || !provider || typeof validateCalldata !== "function") {
      throw new Error("invalid-execution-lifecycle-config");
    }
    this.policy = policy;
    this.ledger = ledger;
    this.provider = provider;
    this.validateCalldata = validateCalldata;
    this.running = new Set();
  }

  async submit(rawIntent, { now = Date.now() } = {}) {
    const spent = this.ledger.snapshot(now).spentWei;
    const evaluated = evaluateExecutionPolicy(rawIntent, this.policy, {
      now, dailySpentWei: spent,
    });
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
      this.ledger.record({ intentId: intent.id, amountWei: intent.valueWei }, now);
    } catch (error) {
      this.running.delete(intent.id);
      return Object.freeze({ status: "rejected", stage: "reservation", failures: [error.message] });
    }

    try {
      state.stage = "signing";
      const signed = await this.provider.sign(intent);
      state.stage = "broadcasting";
      const transactionHash = await this.provider.broadcast(signed, intent);
      if (!TX_HASH.test(String(transactionHash))) throw new Error("invalid-transaction-hash");
      state.transactionHash = transactionHash.toLowerCase();
      state.stage = "confirming";
      const receipt = await this.provider.waitForReceipt(state.transactionHash, intent);
      const succeeded = receipt?.status === "success" || receipt?.status === 1 || receipt?.status === "0x1";
      return Object.freeze({
        ...state,
        stage: "confirmed",
        status: succeeded ? "confirmed" : "reverted",
        receipt,
      });
    } catch (error) {
      throw new ExecutionLifecycleError(state.stage, error, state);
    } finally {
      this.running.delete(intent.id);
    }
  }
}
