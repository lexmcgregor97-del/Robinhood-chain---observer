import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openLiveExecutionStore } from "./live-execution-store.js";

test("durably restores worker-owned execution state against its evidence chain", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atlas-live-store-"));
  const paths = { statePath: join(dir, "state.json"), evidencePath: join(dir, "evidence.jsonl"),
    now: () => 1_000 };
  const first = await openLiveExecutionStore(paths);
  await first.journal.transition("intent-1", { status: "reserved", chainId: 4663,
    spendAsset: "0x0000000000000000000000000000000000000001", spendAmount: "1" }, 1_000);
  const restored = await openLiveExecutionStore(paths);
  assert.equal(restored.journal.get("intent-1").status, "reserved");
  assert.equal(restored.snapshot().evidenceSequence, 1);
});

test("fails closed when state is behind or evidence is modified", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atlas-live-store-"));
  const paths = { statePath: join(dir, "state.json"), evidencePath: join(dir, "evidence.jsonl") };
  const store = await openLiveExecutionStore(paths);
  await store.journal.transition("intent-1", { status: "rejected" });
  const state = JSON.parse(await readFile(paths.statePath, "utf8"));
  state.evidenceSequence = 0;
  await writeFile(paths.statePath, JSON.stringify(state));
  await assert.rejects(openLiveExecutionStore(paths), /live-evidence-state-divergence/);
});

test("refuses open and later mutations while the offline recovery lock exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atlas-live-store-"));
  const paths = { statePath: join(dir, "state.json"), evidencePath: join(dir, "evidence.jsonl") };
  let locked = true;
  await assert.rejects(openLiveExecutionStore({ ...paths, lockPresent: async () => locked }),
    /execution-recovery-lock-present/);
  locked = false;
  const store = await openLiveExecutionStore({ ...paths, lockPresent: async () => locked });
  locked = true;
  await assert.rejects(store.journal.transition("x", { status: "rejected" }),
    /execution-recovery-lock-present/);
  assert.equal(store.writeBlocked, true);
});
