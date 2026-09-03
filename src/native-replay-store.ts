import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_NATIVE_REPLAY_LIMIT = 512;

export interface NativeReplayState {
  version: 1;
  keys: string[];
}

function validReplayKey(value: unknown): value is string {
  return typeof value === "string" && value.length >= 34 && value.length <= 512 && value.includes(":");
}

export async function loadNativeReplayState(filePath: string, limit = DEFAULT_NATIVE_REPLAY_LIMIT): Promise<NativeReplayState> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, keys: [] };
    throw error;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("invalid native replay state");
  const state = parsed as Record<string, unknown>;
  if (state.version !== 1 || !Array.isArray(state.keys)) throw new Error("invalid native replay state");
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const key of state.keys) {
    if (!validReplayKey(key)) throw new Error("invalid native replay key");
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(key);
    }
  }
  return { version: 1, keys: unique.slice(-Math.max(1, Math.trunc(limit))) };
}

export function appendNativeReplayKey(state: NativeReplayState, replayKey: string, limit = DEFAULT_NATIVE_REPLAY_LIMIT): NativeReplayState {
  if (!validReplayKey(replayKey)) throw new Error("invalid native replay key");
  if (state.keys.includes(replayKey)) throw new Error("native replay key already recorded");
  return { version: 1, keys: [...state.keys, replayKey].slice(-Math.max(1, Math.trunc(limit))) };
}

export async function saveNativeReplayState(filePath: string, state: NativeReplayState): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tempPath = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${randomUUID()}`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tempPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tempPath, filePath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}
