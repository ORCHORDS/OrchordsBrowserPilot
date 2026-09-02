import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(repoRoot, "extension", "manifest.json");
const packagePath = path.join(repoRoot, "package.json");

test("extension foundation is a permission-minimal Manifest V3 package", async () => {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    manifest_version?: number;
    name?: string;
    version?: string;
    background?: { service_worker?: string; type?: string };
    permissions?: string[];
    host_permissions?: string[];
  };
  const pkg = JSON.parse(await readFile(packagePath, "utf8")) as { version?: string };

  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.name?.trim());
  assert.match(manifest.version ?? "", /^\d+(?:\.\d+){0,3}$/);
  assert.equal(manifest.version, pkg.version, "extension version must match root package version");
  assert.equal(manifest.background?.service_worker, "service-worker.js");
  assert.equal(manifest.background?.type, "module");

  await access(path.join(repoRoot, "extension", manifest.background!.service_worker!));

  assert.equal(manifest.host_permissions, undefined);
  const permissions = manifest.permissions ?? [];
  for (const permission of ["debugger", "nativeMessaging", "scripting", "tabs", "webRequest"]) {
    assert.equal(permissions.includes(permission), false, `foundation must not request ${permission}`);
  }
  assert.equal(permissions.includes("<all_urls>"), false);
});
