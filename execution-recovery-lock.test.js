import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  executionRecoveryLockPath, executionRecoveryLockPresent,
} from "./execution-recovery-lock.js";

test("detects only the adjacent execution recovery lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atlas-recovery-lock-"));
  try {
    const statePath = join(dir, "state.json");
    assert.equal(await executionRecoveryLockPresent(statePath), false);
    assert.equal(executionRecoveryLockPath(statePath), `${statePath}.execution-recovery.lock`);
    await writeFile(executionRecoveryLockPath(statePath), "locked", "utf8");
    assert.equal(await executionRecoveryLockPresent(statePath), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
