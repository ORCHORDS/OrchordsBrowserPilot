import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendNativeReplayKey,
  loadNativeReplayState,
  saveNativeReplayState,
} from "../src/native-replay-store.js";

const key = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}:${"a".repeat(64)}`;

test("native replay state survives restart with private durable storage (#123)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "native-replay-"));
  const file = path.join(dir, "replay.json");
  let state = await loadNativeReplayState(file);
  state = appendNativeReplayKey(state, key(1));
  await saveNativeReplayState(file, state);
  const restored = await loadNativeReplayState(file);
  assert.deepEqual(restored.keys, [key(1)]);
  if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("native replay state rejects duplicates and remains bounded (#123)", () => {
  let state = { version: 1 as const, keys: [] as string[] };
  state = appendNativeReplayKey(state, key(1), 2);
  assert.throws(() => appendNativeReplayKey(state, key(1), 2), /already recorded/i);
  state = appendNativeReplayKey(state, key(2), 2);
  state = appendNativeReplayKey(state, key(3), 2);
  assert.deepEqual(state.keys, [key(2), key(3)]);
});
