import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadJsonState, saveJsonState } from "./state-store.js";

test("state storage is disabled without a path", async () => {
  assert.equal(await loadJsonState(""), null);
  assert.equal(await saveJsonState("", { value: 1 }), false);
});

test("atomically saves and restores versioned JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "observer-state-"));
  try {
    const path = join(dir, "nested", "state.json");
    assert.equal(await loadJsonState(path), null);
    assert.equal(await saveJsonState(path, { value: 42 }), true);
    const restored = await loadJsonState(path);
    assert.equal(restored.version, 1);
    assert.equal(restored.value, 42);
    assert.ok(Number.isFinite(restored.savedAt));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
