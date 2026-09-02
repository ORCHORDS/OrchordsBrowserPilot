import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";

import {
  buildHardening,
  defaultAllowedHosts,
  defaultAllowedOrigins,
} from "../src/http-hardening.ts";
import { loadConfig, isLoopbackHost } from "../src/config.ts";
import type { Request, Response } from "express";
import type { NextFunction } from "express";

/**
 * Security tests for the HTTP hardening stack (issue #43). These exercise
 * the middleware directly against a real Express server bound to an
 * ephemeral loopback port — no browser needed.
 */

const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;

let server: Server;
let callLog: Array<{ method: string; path: string }> = [];

before(async () => {
  const app = express();
  const { stack } = buildHardening({
    allowedOrigins: defaultAllowedOrigins("127.0.0.1", PORT),
    allowedHosts: defaultAllowedHosts("127.0.0.1"),
    rateLimitPerMinute: 5, // deliberately tiny for the 429 test
    maxBodyBytes: 2048,
    requestTimeoutMs: 0, // disable for unit tests (covered by default config)
    trustProxy: false,
  });
  app.use(stack);
  app.use(express.json({ limit: "2kb" }));
  app.post("/mcp", (_req, res) => {
    callLog.push({ method: "POST", path: "/mcp" });
    res.json({ ok: true });
  });
  app.get("/mcp/health", (_req, res) => res.json({ ok: true }));

  await new Promise<void>(resolve => {
    server = app.listen(PORT, "127.0.0.1", resolve);
  });
});

after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

function resetLog(): void {
  callLog = [];
}

async function req(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: string; headers: Headers }> {
  const res = await fetch(`${BASE}${path}`, init);
  return { status: res.status, body: await res.text(), headers: res.headers };
}

describe("HTTP hardening (P0 #43)", () => {
  it("allows a plain local POST with no Origin (curl/SDK clients)", async () => {
    resetLog();
    const r = await req("/mcp", { method: "POST", body: JSON.stringify({ x: 1 }), headers: { "content-type": "application/json" } });
    assert.equal(r.status, 200);
    assert.equal(callLog.length, 1);
  });

  it("allows Origin matching the loopback allowlist", async () => {
    const r = await req("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://localhost:${PORT}` },
      body: "{}",
    });
    assert.equal(r.status, 200);
  });

  it("rejects a foreign Origin with 403 (browser/CSRF defense)", async () => {
    resetLog();
    const r = await req("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example.com" },
      body: "{}",
    });
    assert.equal(r.status, 403);
    assert.match(r.body, /origin not allowed/);
    assert.equal(callLog.length, 0, "handler must not run for rejected origins");
  });

  it("rejects the sandboxed/null Origin with 403", async () => {
    const r = await req("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "null" },
      body: "{}",
    });
    assert.equal(r.status, 403);
  });

  it("rejects a DNS-rebinding Host with 403", async () => {
    // rebinder.example resolving to 127.0.0.1: Host says the attacker's
    // domain — allowlist must refuse.
    const r = await req("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", host: "rebind.example.com", origin: `http://rebind.example.com:${PORT}` },
      body: "{}",
    });
    assert.equal(r.status, 403);
  });

  it("rejects disallowed methods with 405 and an Allow header", async () => {
    const r = await req("/mcp", { method: "PUT" });
    assert.equal(r.status, 405);
    assert.ok(r.headers.get("allow"));
  });

  it("rejects oversized bodies with 413", async () => {
    const big = JSON.stringify({ blob: "x".repeat(64 * 1024) });
    const r = await req("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: big });
    assert.equal(r.status, 413);
  });

  it("health endpoint sets nosniff + no-store + DENY (must run before rate-limit exhaustion)", async () => {
    const r = await req("/mcp/health");
    assert.equal(r.status, 200, "must not be rate-limited yet");
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal(r.headers.get("x-frame-options"), "DENY");
  });

  it("rate-limits after the per-minute allowance with 429 + Retry-After (LAST — exhausts the shared window)", async () => {
    // NOTE: this test intentionally exhausts the shared per-IP window, so
    // it must be the LAST test in this describe block. The limiter counts
    // every request in the 60s window including earlier tests'.
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) {
      const r = await req("/mcp/health");
      codes.push(r.status);
    }
    assert.ok(codes.some(c => c === 429), `expected at least one 429: ${codes.join(",")}`);
    const first429 = codes.indexOf(429);
    assert.ok(codes.slice(first429).every(c => c === 429), `once limited, stays limited: ${codes.join(",")}`);
    const r = await req("/mcp/health");
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get("retry-after") ?? "0") >= 1, "Retry-After must be present");
  });
});

describe("config: public-bind safeguard (P0 #43)", () => {
  it("recognizes loopback vs public hosts", () => {
    assert.ok(isLoopbackHost("127.0.0.1"));
    assert.ok(isLoopbackHost("localhost"));
    assert.ok(isLoopbackHost("::1"));
    assert.ok(!isLoopbackHost("0.0.0.0"));
    assert.ok(!isLoopbackHost("192.168.1.5"));
  });

  it("loads hardening defaults from env", () => {
    const cfg = loadConfig({
      PILOT_TRANSPORT: "http",
      PILOT_HTTP_ALLOWED_ORIGINS: "https://a.example, https://b.example",
      PILOT_HTTP_RATE_LIMIT: "300",
      PILOT_HTTP_MAX_BODY_KB: "64",
    });
    assert.deepEqual(cfg.http.allowedOrigins, ["https://a.example", "https://b.example"]);
    assert.equal(cfg.http.rateLimitPerMinute, 300);
    assert.equal(cfg.http.maxBodyKb, 64);
    assert.equal(cfg.http.trustProxy, false);
    assert.equal(cfg.http.allowPublicBind, false);
  });

  it("defaults rate limit and body cap sanely when env is absent", () => {
    const cfg = loadConfig({});
    assert.equal(cfg.http.rateLimitPerMinute, 120);
    assert.equal(cfg.http.maxBodyKb, 1024);
    assert.equal(cfg.http.requestTimeoutSec, 60);
  });
});

// Keep express types referenced so the import isn't tree-shaken in CI runs.
assert.ok(typeof buildHardening === "function");
assert.ok(typeof defaultAllowedHosts === "function");
assert.ok(typeof defaultAllowedOrigins === "function");