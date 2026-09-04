import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { NativeMessageDecoder, encodeNativeMessage } from "../src/native-messaging.ts";
import { runNativeHost } from "../src/native-host.ts";
import { loadPairingState } from "../src/native-pairing-store.ts";

const origin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/";
const profileId = "profile-a";

async function handshake(options: {
  pairingFile: string;
  installId: string;
  pairingId?: string;
  pairId: string;
  pairByte: number;
}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const errors = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", chunk => chunks.push(Buffer.from(chunk)));
  const running = runNativeHost({
    callerOrigin: origin,
    allowedOrigins: [origin],
    profileId,
    pairingFile: options.pairingFile,
    replayFile: `${options.pairingFile}.replay`,
    input,
    output,
    errors,
    now: () => 1_000,
    randomUUID: () => `response-${options.pairId}`,
    randomNonce: () => "a".repeat(64),
    randomPairingUUID: () => options.pairId,
    randomPairingBytes: (size: number) => Buffer.alloc(size, options.pairByte),
  });
  input.end(
    encodeNativeMessage({
      protocol: 1,
      id: `hello-${options.pairId}`,
      nonce: "b".repeat(64),
      deadlineAt: 2_000,
      type: "bridge.hello",
      payload: { installId: options.installId, pairingId: options.pairingId },
    }),
  );
  await running;
  const decoded = new NativeMessageDecoder().push(Buffer.concat(chunks));
  assert.equal(decoded.length, 1);
  return decoded[0] as {
    type: string;
    payload: { pairingId: string; generation: number; secret?: string; installId: string };
  };
}

test("first install persists pairing before returning the one-time secret (#123)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "native-pair-host-"));
  const file = path.join(dir, "pairings.json");
  const response = await handshake({ pairingFile: file, installId: "install-aaaaaaaa", pairId: "pair-1", pairByte: 1 });
  assert.equal(response.type, "bridge.paired");
  assert.ok(response.payload.secret);
  const state = await loadPairingState(file);
  assert.equal(state.records[0]?.pairingId, response.payload.pairingId);
  assert.equal("secret" in (state.records[0] ?? {}), false);
});

test("known install resumes without re-sending the pairing secret (#123)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "native-pair-host-"));
  const file = path.join(dir, "pairings.json");
  const first = await handshake({ pairingFile: file, installId: "install-aaaaaaaa", pairId: "pair-1", pairByte: 1 });
  const resumed = await handshake({
    pairingFile: file,
    installId: "install-aaaaaaaa",
    pairingId: first.payload.pairingId,
    pairId: "unused-pair",
    pairByte: 2,
  });
  assert.equal(resumed.type, "bridge.ready");
  assert.equal(resumed.payload.pairingId, first.payload.pairingId);
  assert.equal(resumed.payload.secret, undefined);
});

test("extension reinstall revokes old persisted install and returns a fresh credential (#123)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "native-pair-host-"));
  const file = path.join(dir, "pairings.json");
  const first = await handshake({ pairingFile: file, installId: "install-aaaaaaaa", pairId: "pair-1", pairByte: 1 });
  const second = await handshake({ pairingFile: file, installId: "install-bbbbbbbb", pairId: "pair-2", pairByte: 2 });
  assert.equal(second.type, "bridge.paired");
  assert.notEqual(second.payload.pairingId, first.payload.pairingId);
  const state = await loadPairingState(file);
  const oldRecord = state.records.find(record => record.pairingId === first.payload.pairingId);
  const newRecord = state.records.find(record => record.pairingId === second.payload.pairingId);
  assert.equal(oldRecord?.status, "revoked");
  assert.equal(newRecord?.status, "active");
});
