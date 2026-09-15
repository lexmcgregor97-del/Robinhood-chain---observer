import { stat } from "node:fs/promises";

export const executionRecoveryLockPath = (statePath) => (
  statePath ? `${statePath}.execution-recovery.lock` : ""
);

export async function executionRecoveryLockPresent(statePath) {
  const path = executionRecoveryLockPath(statePath);
  if (!path) return false;
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
