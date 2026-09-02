import type { Request, RequestHandler, Response } from "express";

/**
 * Hardening middleware for the Streamable HTTP transport (issue #43).
 *
 * Threat model: the endpoint drives a real browser with broad capability.
 * Browsers enforce same-origin on responses but DNS-rebinding and
 * malicious local pages can still reach a localhost port. Per MCP spec
 * guidance, any request carrying an `Origin` header must match an
 * allowlist or be rejected; `Host` must match the bound host or an
 * explicit allowlist to defeat rebinding; unknown methods are rejected
 * before the JSON parser runs.
 */

export interface HardeningOptions {
  /** Allowed Origin values (exact match, scheme+host+port). */
  allowedOrigins: Set<string>;
  /** Allowed Host header values (host or host:port). */
  allowedHosts: Set<string>;
  /** Requests per minute per client IP before 429. */
  rateLimitPerMinute: number;
  /** Reject request bodies above this size. */
  maxBodyBytes: number;
  /** Hard per-request timeout in ms (0 disables). */
  requestTimeoutMs: number;
  /** Trust X-Forwarded-For (set only behind a trusted reverse proxy). */
  trustProxy: boolean;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function firstHeader(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v && v.length > 0 ? v : undefined;
}

/** Normalize `Host` header (strip default ports so :80/:443 match). */
function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/:80$/, "").replace(/:443$/, "");
}

/** Normalize `Origin`/`Referer` to a comparable origin string. */
function normalizeOrigin(origin: string): string {
  const trimmed = origin.trim().toLowerCase();
  try {
    const u = new URL(trimmed);
    return `${u.protocol}//${u.host}`;
  } catch {
    return trimmed;
  }
}

function clientIpFromReq(trustProxy: boolean): (req: Request) => string {
  return (req: Request) => {
    if (trustProxy) {
      const fwd = firstHeader(req.headers["x-forwarded-for"]);
      if (fwd) return fwd.split(",")[0]!.trim();
    }
    return req.socket.remoteAddress ?? "unknown";
  };
}

/**
 * Build the full hardening stack. Order matters:
 *   1. host check (cheapest, defeats rebinding before parsing)
 *   2. origin check (must pass whenever Origin is present)
 *   3. body-size gate (Content-Length only — the parser enforces streamed)
 *   4. rate limit (per client IP, fixed window)
 *   5. method allowlist
 *   6. request timeout
 *   7. security headers
 */
export function buildHardening(opts: {
  allowedOrigins: Set<string>;
  allowedHosts: Set<string>;
  rateLimitPerMinute: number;
  maxBodyBytes: number;
  requestTimeoutMs: number;
  trustProxy: boolean;
}): { stack: RequestHandler[]; clientIp: (req: Request) => string } {
  const clientIp = clientIpFromReq(opts.trustProxy);
  const hits = new Map<string, { count: number; windowStart: number }>();
  const WINDOW_MS = 60_000;

  const hostCheck: RequestHandler = (req, res, next) => {
    const host = firstHeader(req.headers.host);
    if (!host) {
      res.status(400).json({ error: "missing Host header" });
      return;
    }
    const norm = normalizeHost(host);
    const hostNoPort = norm.replace(/:\d+$/, "");
    const ok = opts.allowedHosts.has(norm) || opts.allowedHosts.has(hostNoPort) || LOOPBACK_HOSTS.has(hostNoPort);
    if (!ok) {
      res.status(403).json({ error: "host not allowed" });
      return;
    }
    next();
  };

  const originCheck: RequestHandler = (req, res, next) => {
    const origin = firstHeader(req.headers.origin);
    if (origin === undefined) {
      // No Origin: non-browser client (curl, SDK). Authentication (#42)
      // governs those; nothing to validate here.
      next();
      return;
    }
    const norm = normalizeOrigin(origin);
    if (norm === "null" || !opts.allowedOrigins.has(norm)) {
      res.status(403).json({ error: "origin not allowed" });
      return;
    }
    next();
  };

  const bodySizeGate: RequestHandler = (req, res, next) => {
    const len = Number(firstHeader(req.headers["content-length"]) ?? "0");
    if (Number.isFinite(len) && len > opts.maxBodyBytes) {
      res.status(413).json({ error: "request body too large" });
      return;
    }
    next();
  };

  const rateLimit: RequestHandler = (req, res, next) => {
    const ip = clientIp(req);
    const now = Date.now();
    const entry = hits.get(ip);
    if (!entry || now - entry.windowStart >= WINDOW_MS) {
      hits.set(ip, { count: 1, windowStart: now });
      next();
      return;
    }
    entry.count += 1;
    if (entry.count > opts.rateLimitPerMinute) {
      const retryAfterSec = Math.ceil((entry.windowStart + WINDOW_MS - now) / 1000);
      res.setHeader("Retry-After", String(Math.max(1, retryAfterSec)));
      res.status(429).json({ error: "rate limit exceeded" });
      return;
    }
    next();
  };

  const methodCheck: RequestHandler = (req, res, next) => {
    const method = req.method.toUpperCase();
    if (method !== "POST" && method !== "GET" && method !== "DELETE" && method !== "OPTIONS") {
      res.setHeader("Allow", "GET, POST, DELETE, OPTIONS");
      res.status(405).json({ error: "method not allowed" });
      return;
    }
    next();
  };

  const timeoutWare: RequestHandler = (req, res, next) => {
    if (opts.requestTimeoutMs <= 0) {
      next();
      return;
    }
    const timer = setTimeout(() => {
      if (!res.headersSent) {
        res.status(504).json({ error: "request timeout" });
      }
      res.destroy();
    }, opts.requestTimeoutMs);
    res.on("finish", () => clearTimeout(timer));
    req.on("close", () => clearTimeout(timer));
    next();
  };

  const headers: RequestHandler = (_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Frame-Options", "DENY");
    next();
  };

  return { stack: [hostCheck, originCheck, bodySizeGate, rateLimit, methodCheck, timeoutWare, headers], clientIp };
}

/**
 * Compute the default origin allowlist for a given bind host/port: the
 * literal host plus common loopback variants, so a stock localhost server
 * works out of the box without configuration.
 */
export function defaultAllowedOrigins(host: string, port: number): Set<string> {
  const origins = new Set<string>();
  const addHost = (h: string) => {
    origins.add(`http://${h}:${port}`);
    origins.add(`https://${h}:${port}`);
  };
  addHost(host);
  addHost("localhost");
  addHost("127.0.0.1");
  addHost("[::1]");
  return origins;
}

/** Host header values (normalized) that match the bind address. */
export function defaultAllowedHosts(host: string): Set<string> {
  const hosts = new Set<string>();
  hosts.add(host.toLowerCase());
  if (host === "127.0.0.1" || host === "localhost") {
    hosts.add("localhost");
    hosts.add("127.0.0.1");
    hosts.add("[::1]");
    hosts.add("::1");
  }
  return hosts;
}

export type { Request, Response };