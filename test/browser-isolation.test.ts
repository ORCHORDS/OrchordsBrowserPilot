import assert from "node:assert/strict";
import test from "node:test";

import {
  browserIsolationCapability,
  browserIsolationLaunchOptions,
  DEFAULT_BROWSER_ISOLATION_MODE,
} from "../src/browser-isolation.js";

test("browser isolation defaults to trusted-local without claiming Chromium sandbox", () => {
  assert.equal(DEFAULT_BROWSER_ISOLATION_MODE, "trusted-local");
  assert.deepEqual(browserIsolationCapability(), {
    mode: "trusted-local",
    chromiumSandboxRequested: false,
    enforcement: "trusted-local",
  });
  assert.deepEqual(browserIsolationLaunchOptions(), {
    chromiumSandbox: false,
  });
});

test("required Chromium sandbox mode requests fail-closed sandbox launch", () => {
  assert.deepEqual(browserIsolationCapability("require-chromium-sandbox"), {
    mode: "require-chromium-sandbox",
    chromiumSandboxRequested: true,
    enforcement: "fail-closed-request",
  });
  assert.deepEqual(browserIsolationLaunchOptions("require-chromium-sandbox"), {
    chromiumSandbox: true,
  });
});
