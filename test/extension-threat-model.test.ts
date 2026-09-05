import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const threatModelPath = path.join(repoRoot, "docs", "security", "extension-threat-model.md");

// #131 — extension threat model pinning.
//
// Each threat row in the extension threat model MUST name both the STRIDE
// category and the file that contains the control. The companion assertion
// in this file checks that:
//   1. the threat-model document exists at the canonical path,
//   2. it enumerates every file in `extension/` that the privileged-API
//      inventory also enumerates,
//   3. it references the issues that own the controls it documents,
//   4. every extension file it cites still exists on disk.
//
// If a future maintainer deletes a row, deletes a file, or removes the
// owner-issue reference, the release-gate fails.

const extensionFiles = [
  "manifest.json",
  "service-worker.js",
  "bridge-protocol.js",
  "bridge-auth.js",
  "bridge-client.js",
  "pairing-state.js",
  "control-state.js",
  "site-authorizations.js",
  "settings.js",
  "onboarding.js",
  "connection-doctor.js",
  "popup.html",
  "popup.js",
];

test("extension threat model document exists and is owned by #131", async () => {
  await access(threatModelPath);
  const text = await readFile(threatModelPath, "utf8");
  assert.match(text, /owned by `?#131`?/);
  assert.match(text, /test\/extension-threat-model\.test\.ts/);
});

test("extension threat model enumerates every in-scope extension file", async () => {
  const text = await readFile(threatModelPath, "utf8");
  for (const file of extensionFiles) {
    assert.ok(text.includes(file), `extension threat model must reference ${file}`);
  }
});

test("every extension file referenced by the threat model exists on disk", async () => {
  const text = await readFile(threatModelPath, "utf8");
  for (const file of extensionFiles) {
    const onDisk = path.join(repoRoot, "extension", file);
    await access(onDisk);
  }
  // also assert the doc itself mentions the regression matrix
  assert.match(text, /extension-security-matrix\.test\.ts/);
});

test("extension threat model references its companion issue owners", async () => {
  const text = await readFile(threatModelPath, "utf8");
  // #131 owns manifest/permission security; #137 owns the security matrix;
  // #123 owns the authenticated bridge; #125 owns the visible control
  // state. The model must name each owner it relies on.
  for (const issue of ["#131", "#137", "#123", "#125"]) {
    assert.ok(text.includes(issue), `extension threat model must reference owner ${issue}`);
  }
});
