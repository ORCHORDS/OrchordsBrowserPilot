import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

test("stdio and HTTP launch paths forward the validated isolation mode (#106)", async () => {
  const serverSource = await readFile(new URL("../src/server.ts", import.meta.url), "utf8");
  const explicitLaunches = serverSource.match(
    /createBrowserManager\(\s*config\.browser\.wsEndpoint,\s*config\.browser\.headless,\s*config\.browser\.isolation,?\s*\)/g,
  ) ?? [];
  assert.equal(
    explicitLaunches.length,
    2,
    "both stdio and HTTP browser-manager construction must forward config.browser.isolation",
  );
});
