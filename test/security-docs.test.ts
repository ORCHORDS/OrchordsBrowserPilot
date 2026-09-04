import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const security = readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");

test("security policy does not ship setup placeholders", () => {
  assert.doesNotMatch(security, /replace with the\s+real address once configured/i);
  assert.match(security, /security@orchords\.com/);
});

test("security policy does not overstate Chromium sandboxing", () => {
  assert.doesNotMatch(security, /launches a sandboxed chromium/i);
  assert.match(security, /does not currently explicitly enable Chromium's process sandbox/i);
});
