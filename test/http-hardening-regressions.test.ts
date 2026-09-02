import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import type { Server } from "node:http";

import { buildHardening } from "../src/http-hardening.ts";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

/**
 * Raw-socket request helper. fetch() silently rewrites forbidden header
 * names (Host is one of them), so tests that prove Host-based rejection
 * must speak HTTP directly.
 */
function rawRequest(
  base: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        method: init.method ?? "GET",
        path: "/work",
        headers: init.headers,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString("utf8");
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

async function start(
  opts: Record<string, unknown>,
  handler?: Parameters<ReturnType<typeof express>["get"]>[1],
) {
  const app = express();
  const hardening = buildHardening({
    allowedOrigins: new Set(["http://127.0.0.1"]),
    allowedHosts: new Set(["127.0.0.1"]),
    rateLimitPerMinute: 100,
    maxBodyBytes: 4096,
    requestTimeoutMs: 0,
    trustProxy: false,
    ...opts,
  } as never);
  app.use(hardening.stack);
  app.use(express.json({ limit: "4kb" }));
  app.get("/work", handler ?? ((_req, res) => res.json({ ok: true })));
  app.post("/work", handler ?? ((_req, res) => res.json({ ok: true })));
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP address");
  return { base: `http://127.0.0.1:${address.port}`, hardening };
}

describe("HTTP hardening regression contract (#43)", () => {
  it("applies security headers to rejection responses", async () => {
    const { base } = await start({});
    const res = await rawRequest(base, { headers: { Host: "evil.example" } });
    assert.equal(res.status, 403);
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.equal(res.headers["cache-control"], "no-store");
    assert.equal(res.headers["x-frame-options"], "DENY");
  });

  it("does not implicitly accept localhost when the configured Host allowlist is public-only", async () => {
    const { base } = await start({ allowedHosts: new Set(["pilot.example.com"]) });
    const res = await rawRequest(base, { headers: { Host: "localhost" } });
    assert.equal(res.status, 403);
  });

  it("trusts X-Forwarded-For only when the direct socket peer is explicitly trusted", async () => {
    const { base } = await start({
      rateLimitPerMinute: 1,
      trustedProxies: new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]),
    });
    const first = await fetch(`${base}/work`, { headers: { "X-Forwarded-For": "198.51.100.10" } });
    const second = await fetch(`${base}/work`, { headers: { "X-Forwarded-For": "198.51.100.11" } });
    assert.equal(first.status, 200);
    assert.equal(
      second.status,
      200,
      "different forwarded clients behind a trusted proxy need separate buckets",
    );
  });

  it("walks a trusted proxy chain from right to left and chooses the nearest untrusted client", async () => {
    const { hardening } = await start({
      trustedProxies: new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "10.0.0.2"]),
    });
    const fake = {
      headers: { "x-forwarded-for": "198.51.100.20, 10.0.0.2" },
      socket: { remoteAddress: "127.0.0.1" },
    } as never;
    assert.equal(hardening.clientIp(fake), "198.51.100.20");
  });

  it("bounds forwarded-chain size instead of accepting an unbounded spoofing header", async () => {
    const { base } = await start({
      trustedProxies: new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]),
      maxForwardedHops: 4,
    });
    const chain = Array.from({ length: 8 }, (_, i) => `198.51.100.${i + 1}`).join(", ");
    const res = await fetch(`${base}/work`, { headers: { "X-Forwarded-For": chain } });
    assert.equal(res.status, 400);
  });

  it("bounds rate-limiter key memory under many distinct clients", async () => {
    const { base, hardening } = await start({
      trustedProxies: new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]),
      rateLimitMaxKeys: 3,
    });
    for (let i = 1; i <= 8; i += 1) {
      await fetch(`${base}/work`, { headers: { "X-Forwarded-For": `198.51.100.${i}` } });
    }
    assert.ok(hardening.rateLimiterSize() <= 3, `rate limiter retained ${hardening.rateLimiterSize()} keys`);
  });

  it("rejects excess concurrent requests before handler/browser allocation", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { base } = await start({ maxConcurrentRequests: 1 }, async (_req, res) => {
      await gate;
      res.json({ ok: true });
    });
    const first = fetch(`${base}/work`);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const second = await fetch(`${base}/work`);
    assert.equal(second.status, 503);
    release();
    assert.equal((await first).status, 200);
  });

  it("keeps the operation deadline armed after the inbound request body is complete", async () => {
    const { base } = await start({ requestTimeoutMs: 40 }, async (_req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (!res.headersSent) res.json({ late: true });
    });
    const res = await fetch(`${base}/work`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 504);
  });
});
