import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("package-extension produces a deterministic dry-run summary (#135)", async () => {
  const { stdout } = await execFileP(
    "node",
    [path.join(repoRoot, "scripts", "package-extension.mjs")],
    { cwd: repoRoot, env: { ...process.env, CRX_SIGNING_KEY: "", CRX_SIGNING_KEY_ID: "" } },
  );
  // The script prints a JSON summary followed by a one-line note. Find
  // the JSON object by tracking brace depth.
  const start = stdout.indexOf("{");
  assert.ok(start >= 0, "packager must print a JSON object");
  let depth = 0;
  let end = -1;
  for (let i = start; i < stdout.length; i += 1) {
    const c = stdout[i];
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  assert.ok(end > start, "packager JSON must terminate");
  const summary = JSON.parse(stdout.slice(start, end));
  assert.equal(summary.mode, "dry-run");
  assert.equal(summary.product, "orchords-web-pilot");
  assert.match(summary.manifestChecksum, /^[a-f0-9]{64}$/);
  assert.match(summary.zipChecksum, /^[a-f0-9]{64}$/);
  assert.equal(summary.signing, false);
  assert.equal(summary.store, false);
  assert.ok(summary.entries.includes("manifest.json"));
  assert.ok(summary.entries.includes("service-worker.js"));
  // stable file order — manifest.json must come before service-worker.js
  const mi = summary.entries.indexOf("manifest.json");
  const swi = summary.entries.indexOf("service-worker.js");
  assert.ok(mi < swi, "manifest.json must be sorted before service-worker.js");
});

test("package-extension flags mismatched manifest version (#135)", async () => {
  // We cannot override the on-disk manifest from the test process
  // (the script reads it directly), so we instead inject the
  // mismatch by setting the package.json version to a different
  // value before invoking the script, restoring it afterwards.
  const pkgPath = path.join(repoRoot, "package.json");
  const original = await import("node:fs/promises").then((m) => m.readFile(pkgPath, "utf8"));
  const tampered = original.replace(/"version": "[^"]+"/, '"version": "9.9.9-bogus"');
  try {
    await import("node:fs/promises").then((m) => m.writeFile(pkgPath, tampered));
    await assert.rejects(
      execFileP("node", [path.join(repoRoot, "scripts", "package-extension.mjs")], { cwd: repoRoot }),
      /manifest version \(0\.1\.0\) does not match package\.json/,
    );
  } finally {
    await import("node:fs/promises").then((m) => m.writeFile(pkgPath, original));
  }
});

test("submit-extension refuses to run without a built bundle (#136)", async () => {
  await assert.rejects(
    execFileP("node", [
      path.join(repoRoot, "scripts", "submit-extension.mjs"),
      "--version=0.0.0-not-built",
    ], { cwd: repoRoot }),
    /bundle missing/,
  );
});
