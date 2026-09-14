import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EvidenceJournal } from "./evidence-journal.js";

test("appends and restores a hash-chained evidence journal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-evidence-"));
  const path = join(directory, "epoch.jsonl");
  const journal = new EvidenceJournal(path);
  await journal.initialize();
  const first = await journal.append({ type: "paper-open", value: 1 });
  const second = await journal.append({ type: "paper-close", value: 2 });
  assert.equal(first.sequence, 1);
  assert.equal(second.previousHash, first.hash);
  const restored = new EvidenceJournal(path);
  await restored.initialize();
  assert.equal(restored.snapshot().sequence, 2);
  assert.equal(restored.snapshot().lastHash, second.hash);
});

test("rejects a modified evidence chain", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-evidence-"));
  const path = join(directory, "epoch.jsonl");
  const journal = new EvidenceJournal(path);
  await journal.initialize();
  await journal.append({ type: "paper-open", value: 1 });
  const raw = await readFile(path, "utf8");
  await writeFile(path, raw.replace('"value":1', '"value":9'));
  const restored = new EvidenceJournal(path);
  await assert.rejects(() => restored.initialize(), /invalid-evidence-chain/);
  assert.equal(restored.snapshot().healthy, false);
});

test("disabled evidence journal fails closed", async () => {
  const journal = new EvidenceJournal("");
  assert.equal(await journal.initialize(), false);
  await assert.rejects(() => journal.append({ type: "x" }), /disabled/);
  assert.equal(journal.snapshot().healthy, false);
});
