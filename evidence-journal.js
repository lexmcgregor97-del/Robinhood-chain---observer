import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

const ZERO_HASH = "0".repeat(64);
const HASH = /^[0-9a-f]{64}$/;

const digest = (value) => createHash("sha256").update(value).digest("hex");

function encodedRecord(sequence, previousHash, payload) {
  return JSON.stringify({ sequence, previousHash, payload });
}

export class EvidenceJournal {
  constructor(path) {
    this.path = String(path || "");
    this.enabled = Boolean(this.path);
    this.sequence = 0;
    this.lastHash = ZERO_HASH;
    this.initialized = false;
    this.healthy = this.enabled;
    this.lastError = this.enabled ? null : "evidence-journal-disabled";
    this.queue = Promise.resolve();
  }

  async initialize() {
    if (!this.enabled) return false;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, "", { encoding: "utf8", mode: 0o600 });
      let raw = "";
      try {
        raw = await readFile(this.path, "utf8");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      let expectedPrevious = ZERO_HASH;
      let expectedSequence = 1;
      for (const line of raw.split("\n").filter(Boolean)) {
        const record = JSON.parse(line);
        if (record.sequence !== expectedSequence
            || record.previousHash !== expectedPrevious
            || !HASH.test(String(record.hash || ""))) throw new Error("invalid-evidence-chain");
        const expectedHash = digest(encodedRecord(
          record.sequence, record.previousHash, record.payload,
        ));
        if (record.hash !== expectedHash) throw new Error("invalid-evidence-chain");
        expectedPrevious = record.hash;
        expectedSequence += 1;
      }
      this.sequence = expectedSequence - 1;
      this.lastHash = expectedPrevious;
      this.initialized = true;
      this.healthy = true;
      this.lastError = null;
      return true;
    } catch (error) {
      this.healthy = false;
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async append(payload) {
    const records = await this.appendMany([payload]);
    return records[0];
  }

  async appendMany(payloads) {
    if (!Array.isArray(payloads) || !payloads.length) return [];
    this.queue = this.queue.then(async () => {
      if (!this.enabled) throw new Error("evidence-journal-disabled");
      if (!this.initialized) throw new Error("evidence-journal-not-initialized");
      let sequence = this.sequence;
      let previousHash = this.lastHash;
      const records = payloads.map((payload) => {
        sequence += 1;
        const hash = digest(encodedRecord(sequence, previousHash, payload));
        const record = { sequence, previousHash, payload, hash };
        previousHash = hash;
        return record;
      });
      try {
        await appendFile(this.path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, {
          encoding: "utf8", mode: 0o600,
        });
        this.sequence = records.at(-1).sequence;
        this.lastHash = records.at(-1).hash;
        this.healthy = true;
        this.lastError = null;
        return structuredClone(records);
      } catch (error) {
        this.healthy = false;
        this.lastError = error instanceof Error ? error.message : String(error);
        throw error;
      }
    });
    return this.queue;
  }

  async contents() {
    if (!this.enabled) throw new Error("evidence-journal-disabled");
    return readFile(this.path, "utf8");
  }

  snapshot() {
    return {
      enabled: this.enabled,
      initialized: this.initialized,
      healthy: this.healthy,
      sequence: this.sequence,
      lastHash: this.lastHash,
      lastError: this.lastError,
      path: this.enabled ? "configured" : null,
    };
  }
}
