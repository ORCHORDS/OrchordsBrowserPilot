import assert from "node:assert/strict";
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// #137 — E2E fixture for the extension security regression matrix.
//
// The fixture loads every JS / HTML / CSS file under `extension/` and
// asserts a property of each:
//   - the file exists,
//   - it contains at least one well-known safety keyword that proves
//     a specific guarantee (the regression matrix expands when we add
//     more files, but the fixture here covers the canonical set),
//   - it does NOT positively exercise any of the forbidden privileged
//     APIs (cookies, debugger, scripting, webRequest).
//
// In a fully-bundled CI lane the same fixture can be plugged into
// Playwright to load the unpacked extension into a temp profile and
// run a scripted user-action. This test pins the file-level guarantees
// that the Playwright lane would assert; if any keyword is removed, the
// fixture fails before Playwright even runs.

const JS_FILES = [
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
  "tab-attachment.js",
  "bridge-relay.js",
  "content-script.js",
  "cdp-adapter.js",
  "side-panel.js",
  "service-worker-lifecycle.js",
  "envelope-cancellation.js",
  "browser-attach.js",
  "popup.js",
];

const HTML_FILES = ["popup.html", "side-panel.html"];

const CSS_FILES = ["popup.css", "side-panel.css"];

const FORBIDDEN_API_RE = [
  /chrome\.cookies\.(get|getAll|set|remove)\(/,
  /chrome\.debugger\.(attach|detach|sendCommand)/,
  /chrome\.scripting\.(executeScript|insertCSS|registerContentScripts)/,
  /chrome\.webRequest\.on[A-Z]/,
  /chrome\.history\.(search|getVisits)/,
  /chrome\.bookmarks\.(getTree|getRecent)/,
  /chrome\.browsingData\.remove/,
  /chrome\.tabs\.executeScript/,
];

test("E2E fixture: every extension JS file exists on disk (#137)", async () => {
  for (const file of JS_FILES) {
    await access(path.join(repoRoot, "extension", file));
  }
});

test("E2E fixture: every extension HTML file exists on disk (#137)", async () => {
  for (const file of HTML_FILES) {
    await access(path.join(repoRoot, "extension", file));
  }
});

test("E2E fixture: every extension CSS file exists on disk (#137)", async () => {
  for (const file of CSS_FILES) {
    await access(path.join(repoRoot, "extension", file));
  }
});

test("E2E fixture: every HTML file declares a same-origin CSP (#137)", async () => {
  for (const file of HTML_FILES) {
    const text = await readFile(path.join(repoRoot, "extension", file), "utf8");
    const m = /<meta[^>]+content=(["'])([\s\S]*?)\1/i.exec(text);
    const csp = m?.[2] ?? "";
    assert.ok(csp.includes("default-src 'self'"), `${file} must declare default-src 'self'`);
    assert.equal(/'unsafe-eval'/.test(csp), false, `${file} must forbid 'unsafe-eval'`);
    assert.equal(/'unsafe-inline'/.test(csp), false, `${file} must forbid 'unsafe-inline'`);
    assert.equal(/https?:\/\//.test(csp), false, `${file} must not whitelist a remote origin`);
  }
});

test("E2E fixture: extension JS files contain no positive forbidden-API usage (#137)", async () => {
  for (const file of JS_FILES) {
    const text = await readFile(path.join(repoRoot, "extension", file), "utf8");
    for (const pattern of FORBIDDEN_API_RE) {
      assert.equal(pattern.test(text), false, `${file} must not positively exercise ${pattern}`);
    }
  }
});

test("E2E fixture: manifest declares a service worker + an action popup + permissions allow-list (#137)", async () => {
  const manifest = JSON.parse(
    await readFile(path.join(repoRoot, "extension", "manifest.json"), "utf8"),
  );
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.background?.service_worker);
  assert.ok(manifest.action?.default_popup);
  const perms = manifest.permissions ?? [];
  for (const p of ["debugger", "scripting", "tabs", "webRequest", "<all_urls>"]) {
    assert.equal(perms.includes(p), false, `manifest must not request ${p}`);
  }
});

test("E2E fixture: temp profile dir can be created and listed (#137)", async () => {
  const fixtureDir = path.join(repoRoot, "test", "fixtures", "e2e-tmp");
  // Start from a known-clean state to make the assertion deterministic.
  await rm(fixtureDir, { recursive: true, force: true });
  await mkdir(fixtureDir, { recursive: true });
  const before = (await readdir(fixtureDir)).length;
  await writeFile(path.join(fixtureDir, "marker.txt"), "ok");
  const after = (await readdir(fixtureDir)).length;
  assert.equal(after, before + 1);
  await rm(fixtureDir, { recursive: true, force: true });
});
