import assert from "node:assert/strict";
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
    runNativeHost({ callerOrigin: "https://evil.example", allowedOrigins: [origin], input, output, errors }),
    /caller origin is not allowed/,
  );
});

test("native host answers only the bridge handshake over framed stdout (#123)", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const errors = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", chunk => chunks.push(Buffer.from(chunk)));

  const running = runNativeHost({
    callerOrigin: origin,
    allowedOrigins: [origin],
    input,
    output,
    errors,
    now: () => 1000,
    randomUUID: () => "11111111-1111-4111-8111-111111111111",
    randomNonce: () => "a".repeat(64),
  });
  input.end(
    encodeNativeMessage({
      protocol: 1,
      id: "22222222-2222-4222-8222-222222222222",
      nonce: "b".repeat(64),
      deadlineAt: 2000,
      type: "bridge.hello",
      payload: { extensionId: "abc" },
    }),
  );
  await running;

  const decoder = new NativeMessageDecoder();
  assert.deepEqual(decoder.push(Buffer.concat(chunks)), [
    {
      protocol: 1,
      id: "11111111-1111-4111-8111-111111111111",
      nonce: "a".repeat(64),
      deadlineAt: 31_000,
      type: "bridge.ready",
      payload: { callerOrigin: origin },
    },
  ]);
});
