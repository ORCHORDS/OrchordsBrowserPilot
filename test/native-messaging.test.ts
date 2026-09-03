import assert from "node:assert/strict";
import { endianness } from "node:os";
import test from "node:test";

import {
  NativeMessageDecoder,
  createNativeHostManifest,
  encodeNativeMessage,
  validateNativeCallerOrigin,
} from "../src/native-messaging.ts";

const chromeOrigin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/";
const edgeOrigin = "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/";

test("native messaging framing decodes partial UTF-8 JSON frames (#123)", () => {
  const encoded = encodeNativeMessage({ type: "hello", text: "héllo" });
  const expectedLength = Buffer.byteLength(JSON.stringify({ type: "hello", text: "héllo" }), "utf8");
  assert.equal(endianness() === "LE" ? encoded.readUInt32LE(0) : encoded.readUInt32BE(0), expectedLength);

  const decoder = new NativeMessageDecoder();
  assert.deepEqual(decoder.push(encoded.subarray(0, 3)), []);
  assert.deepEqual(decoder.push(encoded.subarray(3, 8)), []);
  assert.deepEqual(decoder.push(encoded.subarray(8)), [{ type: "hello", text: "héllo" }]);
});

test("native messaging decoder rejects oversized frames before payload allocation (#123)", () => {
  const header = Buffer.alloc(4);
  if (endianness() === "LE") header.writeUInt32LE(2 * 1024 * 1024, 0);
  else header.writeUInt32BE(2 * 1024 * 1024, 0);
  const decoder = new NativeMessageDecoder(1024 * 1024);
  assert.throws(() => decoder.push(header), /exceeds native messaging limit/);
});

test("native caller origin requires an exact configured extension origin (#123)", () => {
  assert.equal(validateNativeCallerOrigin(chromeOrigin, [chromeOrigin, edgeOrigin]), chromeOrigin);
  assert.throws(() => validateNativeCallerOrigin("https://example.com", [chromeOrigin]), /caller origin is not allowed/);
  assert.throws(
    () => validateNativeCallerOrigin("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.evil/", [chromeOrigin]),
    /caller origin is not allowed/,
  );
});

test("native host manifest is stdio-only with exact Chrome and Edge origins (#123)", () => {
  assert.deepEqual(
    createNativeHostManifest({ path: "/opt/orchords/native-host", allowedOrigins: [chromeOrigin, edgeOrigin] }),
    {
      name: "com.orchords.web_pilot",
      description: "Orchords Web Pilot native messaging host",
      path: "/opt/orchords/native-host",
      type: "stdio",
      allowed_origins: [chromeOrigin, edgeOrigin],
    },
  );
});
