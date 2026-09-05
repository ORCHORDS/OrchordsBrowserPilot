import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Canonical extension-security regression matrix (#137).
// Each entry is a file that MUST remain on disk and MUST contain at least one
// assertion keyword that would fail if the corresponding guarantee were deleted.
// Silent deletion of any of these files (or of the assertion that pins the
// guarantee) is a release-gate violation.
type MatrixEntry = {
  relPath: string;
  keywords: ReadonlyArray<string>;
};

const matrix: ReadonlyArray<MatrixEntry> = [
  {
    relPath: "test/extension-manifest.test.ts",
    keywords: ["manifest_version", "nativeMessaging", "unsafe-eval", "debugger"],
  },
  {
    relPath: "test/extension-privileged-apis.test.ts",
    keywords: ["chrome.debugger", "chrome.scripting", "chrome.webRequest", "#131"],
  },
  {
    relPath: "test/extension-bridge-auth.test.ts",
    keywords: ["assert"],
  },
  {
    relPath: "test/extension-bridge-client.test.ts",
    keywords: ["assert"],
  },
  {
    relPath: "test/extension-bridge-protocol.test.ts",
    keywords: ["assert"],
  },
  {
    relPath: "test/extension-native-bridge.test.ts",
    keywords: ["assert"],
  },
  {
    relPath: "test/extension-pairing-state.test.ts",
    keywords: ["assert"],
  },
  {
    relPath: "test/extension-provider-contract.test.ts",
    keywords: ["assert"],
  },
  {
    relPath: "test/native-host-authenticated.test.ts",
    keywords: ["assert"],
  },
  {
    relPath: "test/native-host-pairing.test.ts",
    keywords: ["assert"],
  },
  {
    relPath: "test/native-messaging.test.ts",
    keywords: ["assert"],
  },
  {
    relPath: "test/threat-model.test.ts",
    keywords: ["EXT-NM-LOCAL-001", "MUST NOT claim resistance"],
  },
  {
    relPath: "docs/security/threat-model.md",
    keywords: ["EXT-NM-LOCAL-001", "#131 owns extension manifest/permission security", "#137 owns extension security regression coverage"],
  },
  {
    relPath: "docs/security/extension-privileged-apis.md",
    keywords: ["Forbidden list", "bridge-client.js", "service-worker.js", "pairing-state.js", "bridge-protocol.js", "bridge-auth.js"],
  },
];

test("extension security regression matrix is present and pinned (#137)", async () => {
  for (const entry of matrix) {
    const fullPath = path.join(repoRoot, ...entry.relPath.split("/"));
    await access(fullPath);
    const text = await readFile(fullPath, "utf8");
    for (const keyword of entry.keywords) {
      assert.ok(
        text.includes(keyword),
        `${entry.relPath} must pin keyword ${JSON.stringify(keyword)} so silent deletion of the guarantee is caught`,
      );
    }
  }
});

test("privileged-API inventory enumerates every in-scope extension file (#137)", async () => {
  const inventory = await readFile(
    path.join(repoRoot, "docs", "security", "extension-privileged-apis.md"),
    "utf8",
  );
  for (const file of [
    "bridge-client.js",
    "bridge-protocol.js",
    "bridge-auth.js",
    "pairing-state.js",
    "service-worker.js",
    "manifest.json",
  ]) {
    assert.ok(
      inventory.includes(file),
      `privileged-API inventory must enumerate ${file}`,
    );
  }
  assert.match(inventory, /## Forbidden list/);
  assert.match(inventory, /## Allow-list/);
  assert.match(inventory, /## Inventory by file/);
});

test("extension security tests do not positively exercise forbidden privileged APIs (#137)", async () => {
  // A test that asserts chrome.debugger IS used (as opposed to asserting it is
  // withheld) would silently invert the policy. We scan the extension-*.test.ts
  // files for positive-use patterns of the most dangerous APIs.
  //
  // We exclude `extension-privileged-apis.test.ts` because that test is itself
  // the policy-bearing source of the forbidden-token list; it necessarily cites
  // the same tokens it is supposed to forbid (mirrors the exclusion of the
  // inventory doc in `test/extension-privileged-apis.test.ts`).
  const testDir = path.join(repoRoot, "test");
  const { readdir } = await import("node:fs/promises");
  const names = await readdir(testDir);
  const extensionTests = names.filter(
    (name) =>
      name.startsWith("extension-") &&
      name.endsWith(".test.ts") &&
      name !== "extension-privileged-apis.test.ts",
  );
  assert.ok(
    extensionTests.length >= 8,
    "expected the full extension-*.test.ts set to remain on disk",
  );

  const positiveUse = [
    /chrome\.debugger\.(attach|detach|sendCommand)/,
    /chrome\.scripting\.(executeScript|insertCSS|registerContentScripts)/,
    /chrome\.tabs\.executeScript/,
    /chrome\.webRequest\.on/,
  ];

  for (const name of extensionTests) {
    const text = await readFile(path.join(testDir, name), "utf8");
    for (const pattern of positiveUse) {
      assert.equal(
        pattern.test(text),
        false,
        `test/${name} must not positively exercise ${pattern}`,
      );
    }
  }
});
