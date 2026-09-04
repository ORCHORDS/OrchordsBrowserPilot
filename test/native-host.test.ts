import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { NativeMessageDecoder, encodeNativeMessage } from "../src/native-messaging.ts";
import { parseNativeAllowedOrigins, runNativeHost } from "../src/native-host.ts";

const origin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/";

test("native host allowed-origin configuration is explicit and deduplicated (#123)", () => {
  assert.deepEqual(parseNativeAllowedOrigins(`${origin},${origin}`), [origin]);
  assert.throws(() => parseNativeAllowedOrigins(""), /allowed origins are required/);
});

test("native host rejects an unapproved browser caller before processing stdin (#123)", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const errors = new PassThrough();
  await assert.rejects(
    runNativeHost({
      callerOrigin: "https://evil.example",
      allowedOrigins: [origin],
      profileId: "profile-a",
      pairingFile: "/unused/pairings.json",
      replayFile: "/unused/replay.json",
      input,
      output,
      errors,
    }),
    /caller origin is not allowed/,
  );
});

test("native host first handshake returns one-time pairing credential over framed stdout (#123)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "native-host-"));
  const input = new PassThrough();
  const output = new PassThrough();
  const errors = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", chunk => chunks.push(Buffer.from(chunk)));

  const running = runNativeHost({
    callerOrigin: origin,
    allowedOrigins: [origin],
    profileId: "profile-a",
    pairingFile: path.join(dir, "pairings.json"),
    replayFile: path.join(dir, "replay.json"),
    input,
    output,
    errors,
    now: () => 1000,
    randomUUID: () => "11111111-1111-4111-8111-111111111111",
    randomNonce: () => "a".repeat(64),
    randomPairingUUID: () => "pair-1",
    randomPairingBytes: (size: number) => Buffer.alloc(size, 7),
  });
  input.end(
    encodeNativeMessage({
      protocol: 1,
      id: "22222222-2222-4222-8222-222222222222",
      nonce: "b".repeat(64),
      deadlineAt: 2000,
      type: "bridge.hello",
      payload: { installId: "install-aaaaaaaa" },
    }),
  );
  await running;

  const decoded = new NativeMessageDecoder().push(Buffer.concat(chunks));
  assert.equal(decoded.length, 1);
  const message = decoded[0] as {
    type: string;
    auth?: { pairingId: string; generation: number; mac: string };
    payload: { callerOrigin: string; installId: string; pairingId: string; generation: number; secret?: string };
  };
  assert.equal(message.type, "bridge.paired");
  assert.equal(message.payload.callerOrigin, origin);
  assert.equal(message.payload.installId, "install-aaaaaaaa");
  assert.equal(message.payload.pairingId, "pair-1");
  assert.equal(message.payload.generation, 1);
  assert.match(message.payload.secret ?? "", /^[A-Za-z0-9_-]{43}$/);
  assert.equal(message.auth?.pairingId, "pair-1");
});
