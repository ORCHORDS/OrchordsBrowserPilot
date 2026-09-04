import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { NativeMessageDecoder, encodeNativeMessage } from "../src/native-messaging.js";
import { runNativeHost, type NativeToolCaller } from "../src/native-host.js";
import {
  createPairing,
  rotatePairing,
  signBridgeEnvelope,
  verifyBridgeEnvelopeAuth,
} from "../src/native-pairing.js";
import { savePairingState } from "../src/native-pairing-store.js";

const origin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/";
const installId = "a".repeat(64);
const profileId = "profile-a";

function makeEnvelope(id: string, nonceChar: string, type: "bridge.request" | "bridge.cancel", payload: unknown) {
  return {
    protocol: 1 as const,
    id,
    nonce: nonceChar.repeat(64),
    deadlineAt: 2_000,
    type,
    payload,
  };
}

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "native-auth-host-"));
  const pairingFile = path.join(dir, "pairings.json");
  const replayFile = path.join(dir, "replay.json");
  const paired = createPairing({
    callerOrigin: origin,
    installId,
    profileId,
    now: () => 500,
    randomUUID: () => "pair-1",
    randomBytes: (size: number) => Buffer.alloc(size, 0x2a),
  });
  await savePairingState(pairingFile, { version: 1, records: [paired.record] });
  return { pairingFile, replayFile, ...paired };
}

async function runMessages(options: {
  pairingFile: string;
  replayFile: string;
  messages: unknown[];
  toolCaller: NativeToolCaller;
}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const errors = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", chunk => chunks.push(Buffer.from(chunk)));
  let responseId = 0;
  const running = runNativeHost({
    callerOrigin: origin,
    allowedOrigins: [origin],
    profileId,
    pairingFile: options.pairingFile,
    replayFile: options.replayFile,
    toolCaller: options.toolCaller,
    input,
    output,
    errors,
    now: () => 1_000,
    randomUUID: () => `00000000-0000-4000-8000-${String(++responseId).padStart(12, "0")}`,
    randomNonce: () => String(responseId % 10).repeat(64),
  });
  const hello = {
    protocol: 1,
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    nonce: "f".repeat(64),
    deadlineAt: 2_000,
    type: "bridge.hello",
    payload: { installId, pairingId: "pair-1" },
  };
  input.end(Buffer.concat([encodeNativeMessage(hello), ...options.messages.map(message => encodeNativeMessage(message))]));
  await running;
  return new NativeMessageDecoder().push(Buffer.concat(chunks)) as Array<Record<string, unknown>>;
}

test("authenticated native request dispatches exactly once and returns a host-signed response (#123)", async () => {
  const f = await fixture();
  let calls = 0;
  const request = makeEnvelope(
    "11111111-1111-4111-8111-111111111111",
    "b",
    "bridge.request",
    { tool: "browser_console", arguments: { level: "log", limit: 5 } },
  );
  const authenticated = { ...request, auth: signBridgeEnvelope(f.credential, request) };
  const output = await runMessages({
    pairingFile: f.pairingFile,
    replayFile: f.replayFile,
    messages: [authenticated],
    toolCaller: {
      async callTool(name, args) {
        calls += 1;
        assert.equal(name, "browser_console");
        assert.deepEqual(args, { level: "log", limit: 5 });
        return { content: [{ type: "text", text: "[]" }] };
      },
    },
  });
  assert.equal(calls, 1);
  const response = output.find(message => message.type === "bridge.response") as Record<string, unknown> | undefined;
  assert.ok(response);
  const { auth, ...unsigned } = response;
  assert.equal(
    verifyBridgeEnvelopeAuth(
      f.record,
      unsigned,
      auth as { pairingId: string; generation: number; mac: string },
      { callerOrigin: origin, installId, profileId },
    ),
    true,
  );
});

test("replayed signed request is rejected after native-host restart without re-dispatch (#123)", async () => {
  const f = await fixture();
  let calls = 0;
  const request = makeEnvelope(
    "22222222-2222-4222-8222-222222222222",
    "c",
    "bridge.request",
    { tool: "browser_console", arguments: {} },
  );
  const authenticated = { ...request, auth: signBridgeEnvelope(f.credential, request) };
  const caller: NativeToolCaller = {
    async callTool() {
      calls += 1;
      return { ok: true };
    },
  };
  await runMessages({ pairingFile: f.pairingFile, replayFile: f.replayFile, messages: [authenticated], toolCaller: caller });
  await assert.rejects(
    () => runMessages({ pairingFile: f.pairingFile, replayFile: f.replayFile, messages: [authenticated], toolCaller: caller }),
    /replay/i,
  );
  assert.equal(calls, 1);
});

test("signed cancellation aborts an in-flight native bridge request (#123)", async () => {
  const f = await fixture();
  let aborted = false;
  const request = makeEnvelope(
    "33333333-3333-4333-8333-333333333333",
    "d",
    "bridge.request",
    { tool: "browser_wait", arguments: { timeMs: 30_000 } },
  );
  const cancel = makeEnvelope(
    "44444444-4444-4444-8444-444444444444",
    "e",
    "bridge.cancel",
    { requestId: request.id },
  );
  const output = await runMessages({
    pairingFile: f.pairingFile,
    replayFile: f.replayFile,
    messages: [
      { ...request, auth: signBridgeEnvelope(f.credential, request) },
      { ...cancel, auth: signBridgeEnvelope(f.credential, cancel) },
    ],
    toolCaller: {
      async callTool(_name, _args, options) {
        return new Promise((resolve, reject) => {
          const signal = options?.signal;
          if (!signal) return reject(new Error("missing abort signal"));
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(signal.reason ?? new Error("aborted"));
            },
            { once: true },
          );
          void resolve;
        });
      },
    },
  });
  assert.equal(aborted, true);
  const cancelled = output.find(message => message.type === "bridge.cancelled");
  assert.ok(cancelled);
});

test("stale pre-rotation credential cannot dispatch after pairing generation advances (#123)", async () => {
  const f = await fixture();
  const rotated = rotatePairing(f.record, {
    now: () => 750,
    randomBytes: (size: number) => Buffer.alloc(size, 0x4b),
  });
  await savePairingState(f.pairingFile, { version: 1, records: [rotated.record] });
  let calls = 0;
  const request = makeEnvelope(
    "55555555-5555-4555-8555-555555555555",
    "1",
    "bridge.request",
    { tool: "browser_console", arguments: {} },
  );
  const stale = { ...request, auth: signBridgeEnvelope(f.credential, request) };
  await assert.rejects(
    () => runMessages({
      pairingFile: f.pairingFile,
      replayFile: f.replayFile,
      messages: [stale],
      toolCaller: { async callTool() { calls += 1; return { ok: true }; } },
    }),
    /authentication failed/i,
  );
  assert.equal(calls, 0);
});

test("malformed or unauthenticated bridge request never reaches canonical dispatch (#123)", async () => {
  const f = await fixture();
  let calls = 0;
  const request = makeEnvelope(
    "66666666-6666-4666-8666-666666666666",
    "2",
    "bridge.request",
    { tool: "browser_console", arguments: {} },
  );
  await assert.rejects(
    () => runMessages({
      pairingFile: f.pairingFile,
      replayFile: f.replayFile,
      messages: [request],
      toolCaller: { async callTool() { calls += 1; return { ok: true }; } },
    }),
    /auth is missing/i,
  );
  assert.equal(calls, 0);
});

test("unapproved native caller origin is rejected before pairing state or dispatch (#123)", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const errors = new PassThrough();
  await assert.rejects(
    runNativeHost({
      callerOrigin: "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/",
      allowedOrigins: [origin],
      profileId,
      pairingFile: "/unused/pairings.json",
      replayFile: "/unused/replay.json",
      input,
      output,
      errors,
      toolCaller: { async callTool() { throw new Error("must not dispatch"); } },
    }),
    /caller origin is not allowed/i,
  );
});
