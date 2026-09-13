import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
  await writeFile(temporary, payload, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
  return true;
}
