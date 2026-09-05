import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("extension enterprise policy doc exists and is owned by #139", async () => {
  const doc = path.join(repoRoot, "docs", "security", "extension-enterprise-policy.md");
  await access(doc);
  const text = await readFile(doc, "utf8");
  assert.match(text, /owned by `#139`/);
  assert.match(text, /test\/extension-enterprise-policy\.test\.ts/);
});

test("manifest does NOT request the incognito permission (#139)", async () => {
  const manifest = JSON.parse(
    await readFile(path.join(repoRoot, "extension", "manifest.json"), "utf8"),
  );
  assert.equal(manifest.incognito, undefined);
  const perms = manifest.permissions ?? [];
  assert.equal(perms.includes("incognito"), false, "extension must not request the incognito permission");
});

test("manifest does NOT request 'cookies' or 'history' (#139)", async () => {
  const manifest = JSON.parse(
    await readFile(path.join(repoRoot, "extension", "manifest.json"), "utf8"),
  );
  const perms = manifest.permissions ?? [];
  for (const p of ["cookies", "history", "bookmarks", "browsingData", "contentSettings"]) {
    assert.equal(perms.includes(p), false, `extension must not request ${p}`);
  }
});
