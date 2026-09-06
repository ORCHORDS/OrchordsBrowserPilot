import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docsPath = path.join(root, "docs", "security", "extension-privileged-apis.md");

async function text(relative: string): Promise<string> {
  return readFile(path.join(root, relative), "utf8");
}

test("connectNative ownership matches canonical inventory (#131)", async () => {
  const [serviceWorker, bridgeClient, inventory] = await Promise.all([
    text("extension/service-worker.js"),
    text("extension/bridge-client.js"),
    readFile(docsPath, "utf8"),
  ]);

  const connectNativeCalls = (serviceWorker.match(/chrome\.runtime\.connectNative\s*\(/g) ?? []).length;
  assert.equal(connectNativeCalls, 1, "service worker must own exactly one direct connectNative call");
  assert.doesNotMatch(
    bridgeClient,
    /chrome\.runtime\.connectNative\s*\(/,
    "bridge client consumes an injected port and must not create Native Messaging authority",
  );
  assert.match(inventory, /Allowed call site:\*\* `extension\/service-worker\.js` only/);
  assert.match(inventory, /`extension\/bridge-client\.js` \*\*does not call\*\* `connectNative`/);
});

test("shipped manifest permission set is exact and privilege-minimal (#131)", async () => {
  const manifest = JSON.parse(await text("extension/manifest.json"));
  assert.deepEqual(
    [...manifest.permissions].sort(),
    ["activeTab", "alarms", "nativeMessaging", "storage"].sort(),
  );
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.optional_host_permissions, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
});
