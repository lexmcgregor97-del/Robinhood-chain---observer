import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export async function loadJsonState(path) {
  if (!path) return null;
  try {
    const raw = await readFile(path, "utf8");
    const state = JSON.parse(raw);
    if (!state || state.version !== 1 || !Number.isFinite(state.savedAt)) {
      throw new Error("unsupported-state");
    }
    return state;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function saveJsonState(path, state) {
  if (!path) return false;
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  const payload = JSON.stringify({ ...state, version: 1, savedAt: Date.now() });
  const handle = await open(temporary, "w", 0o600);
  try {
    await handle.writeFile(payload, { encoding: "utf8" });
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(temporary).catch(() => {});
    throw error;
  }
  await handle.close();
  await rename(temporary, path);
  const directory = await open(dirname(path), "r");
  try { await directory.sync(); } finally { await directory.close(); }
  return true;
}
