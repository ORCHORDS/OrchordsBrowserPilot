import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionDir = path.join(root, "extension");
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

test("forbidden high-authority calls are absent from executable extension source (#131)", async () => {
  const files = [
    "service-worker.js",
    "bridge-client.js",
    "bridge-protocol.js",
    "bridge-auth.js",
    "pairing-state.js",
    "control-state.js",
    "site-authorizations.js",
    "settings.js",
    "onboarding.js",
    "connection-doctor.js",
    "popup.js",
    "tab-attachment.js",
    "bridge-relay.js",
    "content-script.js",
    "cdp-adapter.js",
    "side-panel.js",
    "service-worker-lifecycle.js",
    "envelope-cancellation.js",
    "browser-attach.js",
    "schema-migrations.js",
    "artifact-transfer.js",
    "support-bundle.js",
  ];
  const source = (await Promise.all(files.map((name) => readFile(path.join(extensionDir, name), "utf8")))).join("\n");
  const forbiddenCallPatterns = [
    /chrome\.debugger\.(attach|detach|sendCommand)\s*\(/,
    /chrome\.scripting\.(executeScript|insertCSS|removeCSS|registerContentScripts)\s*\(/,
    /chrome\.tabs\.executeScript\s*\(/,
    /chrome\.cookies\.[A-Za-z_$][\w$]*\s*\(/,
    /chrome\.history\.[A-Za-z_$][\w$]*\s*\(/,
    /chrome\.webRequest\.[A-Za-z_$][\w$]*/,
    /chrome\.downloads\.[A-Za-z_$][\w$]*\s*\(/,
  ];
  for (const pattern of forbiddenCallPatterns) {
    assert.doesNotMatch(source, pattern, `forbidden privileged API surfaced: ${pattern}`);
  }
});
