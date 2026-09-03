import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPairing } from "../src/native-pairing.js";
import { loadPairingState, savePairingState } from "../src/native-pairing-store.js";

test("missing pairing state loads as an empty versioned store (#123)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pairing-store-"));
  const state = await loadPairingState(path.join(dir, "pairings.json"));
  assert.deepEqual(state, { version: 1, records: [] });
});

test("savePairingState atomically replaces JSON with private permissions (#123)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pairing-store-"));
  const file = path.join(dir, "pairings.json");
  const { record } = createPairing({
    callerOrigin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/",
    installId: "install-a",
    profileId: "profile-a",
    now: () => 1_000,
    randomUUID: () => "pair-1",
    randomBytes: (size: number) => Buffer.alloc(size, 7),
  });
  await savePairingState(file, { version: 1, records: [record] });
  const parsed = JSON.parse(await readFile(file, "utf8")) as { records: Array<{ pairingId: string }> };
  assert.equal(parsed.records[0]?.pairingId, "pair-1");
  if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
  const leftovers = (await readdir(dir)).filter((name) => name.includes(".tmp-"));
  assert.deepEqual(leftovers, []);
});

test("loadPairingState rejects malformed or duplicate records (#123)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pairing-store-"));
  const file = path.join(dir, "pairings.json");
  await writeFile(file, JSON.stringify({ version: 1, records: [{ pairingId: "x" }, { pairingId: "x" }] }));
  await assert.rejects(() => loadPairingState(file), /invalid pairing record|duplicate pairing id/i);
});
