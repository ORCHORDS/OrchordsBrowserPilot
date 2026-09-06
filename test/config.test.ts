import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

test("loadConfig applies defaults", () => {
  const cfg = loadConfig({});
  assert.equal(cfg.transport, "stdio");
  assert.equal(cfg.http.host, "127.0.0.1");
  assert.equal(cfg.http.port, 8788);
  assert.equal(cfg.browser.headless, true);
  assert.equal(cfg.browser.wsEndpoint, undefined);
  assert.equal(cfg.browser.isolation, "trusted-local");
});

test("loadConfig parses http transport", () => {
  const cfg = loadConfig({
    PILOT_TRANSPORT: "http",
    PILOT_HTTP_HOST: "0.0.0.0",
    PILOT_HTTP_PORT: "9001",
    PILOT_HEADLESS: "false",
    BROWSER_WS_ENDPOINT: "wss://example.invalid",
  });
  assert.equal(cfg.transport, "http");
  assert.equal(cfg.http.host, "0.0.0.0");
  assert.equal(cfg.http.port, 9001);
  assert.equal(cfg.browser.headless, false);
  assert.equal(cfg.browser.wsEndpoint, "wss://example.invalid");
});

test("loadConfig accepts explicit Chromium sandbox isolation mode", () => {
  const cfg = loadConfig({
    PILOT_BROWSER_ISOLATION: "require-chromium-sandbox",
  });
  assert.equal(cfg.browser.isolation, "require-chromium-sandbox");
});

test("loadConfig rejects unknown browser isolation mode", () => {
  assert.throws(
    () => loadConfig({ PILOT_BROWSER_ISOLATION: "sandbox-if-convenient" }),
    /Invalid enum value|Invalid option|invalid/i,
  );
});
