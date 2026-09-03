import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

async function text(relative: string): Promise<string> {
  return readFile(path.join(root, relative), "utf8");
}

test("MV3 extension selects persistent Native Messaging as the local bridge default (#123)", async () => {
  const manifest = JSON.parse(await text("extension/manifest.json")) as {
    permissions?: string[];
  };
  const worker = await text("extension/service-worker.js");

  assert.ok(manifest.permissions?.includes("nativeMessaging"), "nativeMessaging permission must be explicit");
  assert.match(worker, /const NATIVE_HOST = ["']com\.orchords\.web_pilot["']/, "native host id must be pinned");
  assert.match(
    worker,
    /chrome\.runtime\.connectNative\(NATIVE_HOST\)/,
    "service worker must use a persistent native messaging port",
  );
  assert.match(worker, /\.onMessage\.addListener\(/, "native port messages must be handled");
  assert.match(worker, /\.onDisconnect\.addListener\(/, "native port disconnects must be handled explicitly");
  assert.doesNotMatch(worker, /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])/i, "no unauthenticated localhost fallback");
  assert.doesNotMatch(worker, /wss?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])/i, "no localhost websocket fallback");
  assert.doesNotMatch(worker, /sendNativeMessage\(/, "bridge must not spawn a fresh native process per request");
});
