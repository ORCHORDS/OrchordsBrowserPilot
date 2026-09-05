import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inventoryPath = path.join(repoRoot, "docs", "security", "extension-privileged-apis.md");
const extensionDir = path.join(repoRoot, "extension");

// Privileged APIs that are withheld from the extension by `extension/manifest.json`
// AND/OR by the canonical policy in `docs/security/extension-privileged-apis.md`.
// A bare token reference to any of these in the extension source tree is a
// release-gate violation: it indicates a future contributor re-introduced an
// API that the manifest is supposed to make unreachable. This is the source-level
// counterpart to `test/extension-manifest.test.ts`, which pins the manifest side.
const forbiddenTokens: ReadonlyArray<string> = [
  "chrome.debugger",
  "chrome.scripting",
  "chrome.webRequest",
  "chrome.proxy",
  "chrome.enterprise.platformKeys",
  "chrome.platformKeys",
  "chrome.management",
  "chrome.cookies",
  "chrome.history",
  "chrome.contentSettings",
  "chrome.privacy",
  "chrome.pageCapture",
  "chrome.tabCapture",
  "chrome.desktopCapture",
  "chrome.identity",
  "chrome.gcm",
  "chrome.pushMessaging",
  "chrome.browsingData",
  "chrome.downloads",
  "chrome.tabs.executeScript",
  "<all_urls>",
];

const inventory = new URL(
  "../docs/security/extension-privileged-apis.md",
  import.meta.url,
);

test("privileged-API inventory doc pins the canonical forbidden list (#131)", async () => {
  const text = await readFile(inventory, "utf8");

  // The inventory must explicitly reference every forbidden token it covers.
  for (const token of forbiddenTokens) {
    assert.ok(
      text.includes(token),
      `inventory must reference forbidden token ${token} so a regression in policy wording is caught`,
    );
  }

  // The inventory must call out the canonical allow-list entries.
  assert.match(text, /chrome\.runtime\.connectNative/);
  assert.match(text, /chrome\.runtime\.sendNativeMessage/);
  assert.match(text, /chrome\.runtime\.onMessage/);
  assert.match(text, /chrome\.runtime\.onConnect/);
  assert.match(text, /chrome\.storage\.local/);
  assert.match(text, /chrome\.action/);

  // The inventory must enumerate every file under extension/ that is in scope.
  for (const file of [
    "service-worker.js",
    "bridge-client.js",
    "bridge-protocol.js",
    "bridge-auth.js",
    "pairing-state.js",
    "manifest.json",
  ]) {
    assert.ok(
      text.includes(file),
      `inventory must enumerate extension/${file}`,
    );
  }

  // The inventory must name the consumers (regression tests) that pin it.
  assert.match(text, /test\/extension-privileged-apis\.test\.ts/);
  assert.match(text, /test\/extension-manifest\.test\.ts/);
  assert.match(text, /test\/extension-security-matrix\.test\.ts/);

  // The inventory must declare its owner.
  assert.match(text, /#131/);
  assert.match(text, /#123/);
  assert.match(text, /#137/);
});

test("extension source tree contains no forbidden privileged-API tokens (#131)", async () => {
  // Walk every file under `extension/` and assert no forbidden token appears.
  // This is a literal-token scan: any future contributor who reaches for a
  // forbidden API (whether or not they also remember to add the corresponding
  // permission to the manifest) fails this test.
  const entries = await readdir(extensionDir, { recursive: true });
  const jsFiles = entries.filter(
    (name) => name.endsWith(".js") || name.endsWith(".json"),
  );
  assert.ok(jsFiles.length > 0, "extension/ should contain at least one source file");

  for (const relName of jsFiles) {
    const fullPath = path.join(extensionDir, relName);
    const text = await readFile(fullPath, "utf8");
    for (const token of forbiddenTokens) {
      assert.equal(
        text.includes(token),
        false,
        `extension/${relName} must not reference forbidden privileged-API token ${token}`,
      );
    }
  }
});

test("manifest stays aligned with the privileged-API inventory (#131)", async () => {
  const inventoryText = await readFile(inventoryPath, "utf8");
  const manifestText = await readFile(
    path.join(extensionDir, "manifest.json"),
    "utf8",
  );

  // Every permission that the inventory says is withheld must not appear in
  // the manifest. This catches "harmless helper permission" re-introductions.
  const withheldPermissions: ReadonlyArray<string> = [
    "debugger",
    "scripting",
    "tabs",
    "webRequest",
    "proxy",
    "management",
    "cookies",
    "history",
    "contentSettings",
    "privacy",
    "pageCapture",
    "tabCapture",
    "desktopCapture",
    "identity",
    "gcm",
    "notifications",
    "browsingData",
    "downloads",
    "<all_urls>",
  ];
  for (const permission of withheldPermissions) {
    assert.equal(
      inventoryText.includes(`\`${permission}\``),
      true,
      `inventory must explicitly cite withheld permission ${permission}`,
    );
    assert.equal(
      manifestText.includes(`"${permission}"`),
      false,
      `manifest must not request withheld permission ${permission}`,
    );
  }
});
