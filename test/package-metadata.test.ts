import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const canonical = "https://github.com/ORCHORDS/OrchordsBrowserPilot";

test("package metadata points to the canonical public repository", () => {
  assert.equal(pkg.repository?.url, `${canonical}.git`);
  assert.equal(pkg.bugs?.url, `${canonical}/issues`);
});
