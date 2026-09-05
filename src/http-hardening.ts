import { isIP } from "node:net";
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
 *
 * Layered defenses (ordered by rejection cost):
 *   1. security headers (sticky on the response, applies even to
 *      short-circuited 4xx/5xx responses)
 *   2. host check (cheapest, defeats rebinding before parsing)
 *   3. origin check (must pass whenever Origin is present)
 *   4. body-size gate (Content-Length only — the parser enforces streamed)
 *   5. concurrency gate (rejects when too many requests are in flight)
 *   6. rate limit (per client IP, fixed window, bounded key memory)
 *   7. method allowlist
 *   8. request timeout
 */
export interface HardeningOptions {
  allowedOrigins: Set<string>;
  allowedHosts: Set<string>;
  rateLimitPerMinute: number;
  maxBodyBytes: number;
  requestTimeoutMs: number;
  /**
   * Enable forwarded-header processing. This flag is NOT a trust boundary by
   * itself: X-Forwarded-For is consulted only when the direct socket peer is
   * also present in `trustedProxies`.
   */
  trustProxy: boolean;
  /**
   * Exact socket-peer IPs that are authorized reverse proxies. When omitted,
   * `PILOT_HTTP_TRUSTED_PROXIES` supplies the same exact-IP list. Empty means
   * forwarded client IP headers are ignored even when `trustProxy` is true.
   */
  trustedProxies?: Set<string>;
  /** Cap the forwarded-for chain length to defeat unbounded spoofing. */
  maxForwardedHops?: number;
  /** Cap distinct client keys kept in the rate limiter (LRU eviction). */
  rateLimitMaxKeys?: number;
  /** Cap concurrent in-flight requests; excess are rejected with 503. */
  maxConcurrentRequests?: number;
}

export interface HardeningHandle {
  stack: RequestHandler[];
  /** Resolve the effective client IP for the given request, walking a
   *  trusted-proxy chain right-to-left and choosing the nearest
   *  untrusted hop. */
  clientIp: (req: RequestLike) => string;
  /** Current number of distinct client keys tracked by the rate limiter. */
  rateLimiterSize: () => number;
}

/** Minimal subset of express Request that `clientIp` consumes. */
export interface RequestLike {
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string | undefined };
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "::ffff:127.0.0.1"]);
const TRUSTED_PROXY_MAX_ENTRIES = 64;
const TRUSTED_PROXY_MAX_TOKEN_BYTES = 64;

function firstHeader(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v && v.length > 0 ? v : undefined;
}

/**
 * Parse an exact-IP trusted-proxy list. Hostnames and CIDR ranges are
 * deliberately rejected in this first secure deployment contract: name
 * resolution and CIDR matching need separate, explicit semantics rather than
 * being guessed inside the request path.
 */
export function parseTrustedProxyList(raw: string | undefined): Set<string> {
  if (!raw || raw.trim().length === 0) return new Set<string>();
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length > TRUSTED_PROXY_MAX_ENTRIES) {
    throw new Error(`PILOT_HTTP_TRUSTED_PROXIES supports at most ${TRUSTED_PROXY_MAX_ENTRIES} IPs`);
  }
  const result = new Set<string>();
  for (const value of values) {
    if (Buffer.byteLength(value, "utf8") > TRUSTED_PROXY_MAX_TOKEN_BYTES || isIP(value) === 0) {
      throw new Error(`PILOT_HTTP_TRUSTED_PROXIES contains invalid IP: ${value}`);
    }
    result.add(value);
  }
  return result;
}

/**
 * Normalize `Host` header by stripping any port suffix and lowercasing.
 * Allowlists normally contain bare hostnames; the port comes from the
 * bind address and is not part of the host identity.
 */
function normalizeHost(host: string): string {
  const trimmed = host.trim().toLowerCase();
  const colon = trimmed.lastIndexOf(":");
  const bracket = trimmed.indexOf("]");
  if (colon >= 0 && (bracket < 0 || colon > bracket) && /^\d+$/.test(trimmed.slice(colon + 1))) {
    return trimmed.slice(0, colon);
  }
  return trimmed;
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

/** Return true iff any entry in `set` is a loopback host string. */
function allowlistContainsLoopback(set: Set<string>): boolean {
  for (const h of set) {
    if (LOOPBACK_HOSTS.has(h.toLowerCase())) return true;
  }
  return false;
}

/**
 * Parse the X-Forwarded-For chain only when the direct socket peer is an
 * explicitly trusted proxy. `trustProxy=true` is merely an enable switch and
 * can never make an arbitrary direct peer trusted.
 */
function forwardedChain(req: RequestLike, trustProxy: boolean, trust: Set<string>): string[] | undefined {
  if (!trustProxy) return undefined;
  const socketIp = req.socket?.remoteAddress ?? "unknown";
  if (trust.size === 0 || !trust.has(socketIp)) return undefined;
  const header = firstHeader(req.headers["x-forwarded-for"]);
  if (!header) return undefined;
  const chain = header
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return chain.length > 0 ? chain : undefined;
}

function makeClientIp(
  trustProxy: boolean,
  trustedProxies: Set<string>,
  maxForwardedHops: number | undefined,
): (req: RequestLike) => string {
  const hopCap = maxForwardedHops ?? 32;
  return (req: RequestLike): string => {
    const socketIp = req.socket?.remoteAddress ?? "unknown";
    const chain = forwardedChain(req, trustProxy, trustedProxies);
    if (!chain) return socketIp;
    if (chain.length > hopCap) return socketIp;

    // The socket peer was already proven trusted by forwardedChain(). Walk
    // the forwarded chain right-to-left and stop at the nearest untrusted
    // address, matching the standard reverse-proxy trust model.
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      const hop = chain[i]!;
      if (!trustedProxies.has(hop)) return hop;
    }

    // Every forwarded hop was trusted. The left-most entry is the furthest
    // known address and therefore the effective client identity.
    return chain[0]!;
  };
}

export function defaultAllowedOrigins(host: string, port: number): Set<string> {
  const origins = new Set<string>();
  const add = (h: string) => {
    origins.add(`http://${h}:${port}`);
  };
  add(host);
  if (host === "127.0.0.1" || host === "localhost") {
    add("localhost");
    add("127.0.0.1");
    add("[::1]");
    add("::1");
  }
  return origins;
}

export function defaultAllowedHosts(host: string): Set<string> {
  const hosts = new Set<string>();
  hosts.add(host.toLowerCase());
  if (host === "127.0.0.1" || host === "localhost") {
    hosts.add("localhost");
    hosts.add("127.0.0.1");
    hosts.add("[::1]");
    hosts.add("::1");
    hosts.add("::ffff:127.0.0.1");
  }
  return hosts;
}

export function buildHardening(opts: HardeningOptions): HardeningHandle {
  const trustedProxies =
    opts.trustedProxies ?? parseTrustedProxyList(process.env.PILOT_HTTP_TRUSTED_PROXIES);
  const clientIp = makeClientIp(opts.trustProxy, trustedProxies, opts.maxForwardedHops);

  const hits = new Map<string, { count: number; windowStart: number }>();
  const WINDOW_MS = 60_000;
  const RATE_LIMIT_KEY_CAP = opts.rateLimitMaxKeys ?? 10_000;
  const rateLimiterSize = () => hits.size;

  const hostCheck: RequestHandler = (req, res, next) => {
    const host = firstHeader(req.headers.host);
    if (!host) {
      res.status(400).json({ error: "missing Host header" });
      return;
    }
    const normalized = normalizeHost(host);
    const allowlistHasLoopback = allowlistContainsLoopback(opts.allowedHosts);
    const candidate =
      normalized.startsWith("[") && normalized.endsWith("]") ? normalized.slice(1, -1) : normalized;
    const allowList = opts.allowedHosts;
    let allowed = allowList.has(normalized) || allowList.has(candidate);
    if (!allowed && allowlistHasLoopback && LOOPBACK_HOSTS.has(candidate)) {
      allowed = true;
    }
    if (!allowed) {
      res.status(403).json({ error: "host not allowed" });
      return;
    }
    next();
  };

  const originCheck: RequestHandler = (req, res, next) => {
    const origin = firstHeader(req.headers.origin);
    if (origin === undefined) {
      next();
      return;
    }
    const normalized = normalizeOrigin(origin);
    if (!opts.allowedOrigins.has(normalized)) {
      res.status(403).json({ error: "origin not allowed" });
      return;
    }
    next();
  };

  const bodySizeGate: RequestHandler = (req, res, next) => {
    const cl = firstHeader(req.headers["content-length"]);
    if (cl && Number.parseInt(cl, 10) > opts.maxBodyBytes) {
      res.status(413).json({ error: "request body too large" });
      return;
    }
    next();
  };

  // Forwarded-chain bound (#43): an XFF chain longer than the configured
  // hop cap is treated as malformed and rejected outright when the request
  // actually came through an explicitly trusted proxy.
  const forwardedBound: RequestHandler = (req, res, next) => {
    const chain = forwardedChain(req, opts.trustProxy, trustedProxies);
    if (chain && chain.length > (opts.maxForwardedHops ?? 32)) {
      res.status(400).json({ error: "malformed x-forwarded-for" });
      return;
    }
    next();
  };

  let inFlight = 0;
  const concurrencyGate: RequestHandler = (req, res, next) => {
    const cap = opts.maxConcurrentRequests ?? Infinity;
    if (cap === Infinity) {
      next();
      return;
    }
    if (inFlight >= cap) {
      res.status(503).json({ error: "server busy" });
      return;
    }
    inFlight += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      inFlight = Math.max(0, inFlight - 1);
    };
    res.on("close", release);
    res.on("finish", release);
    next();
  };

  const rateLimit: RequestHandler = (req, res, next) => {
    if (opts.rateLimitPerMinute <= 0) {
      next();
      return;
    }
    const key = clientIp(req);
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now - entry.windowStart >= WINDOW_MS) {
      // New window. If we're at the cap, evict the oldest key (FIFO).
      if (entry === undefined && hits.size >= RATE_LIMIT_KEY_CAP) {
        const oldest = hits.keys().next().value;
        if (oldest !== undefined) hits.delete(oldest);
      }
      hits.set(key, { count: 1, windowStart: now });
      next();
      return;
    }
    entry.count += 1;
    if (entry.count > opts.rateLimitPerMinute) {
      const retryAfter = Math.max(1, Math.ceil((entry.windowStart + WINDOW_MS - now) / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({ error: "too many requests" });
      return;
    }
    next();
  };

  const methodCheck: RequestHandler = (req, res, next) => {
    const allowed = ["GET", "POST", "DELETE", "OPTIONS"];
    if (!allowed.includes(req.method)) {
      res.setHeader("Allow", allowed.join(", "));
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
      if (!res.writableEnded) {
        res.destroy();
      }
    }, opts.requestTimeoutMs);
    // The deadline spans the whole request/response exchange. It must NOT
    // be cleared when the inbound request body stream ends —
    // express.json() consuming the body closes that stream while the
    // handler is still running. Only response completion clears it.
    res.on("finish", () => clearTimeout(timer));
    res.on("close", () => clearTimeout(timer));
    next();
  };

  // Headers are applied FIRST so short-circuited 4xx/5xx responses also
  // carry them. setHeader is sticky on the response object, so any later
  // res.status(...).json(...) inherits them.
  const headers: RequestHandler = (_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Frame-Options", "DENY");
    next();
  };

  return {
    stack: [
      headers,
      forwardedBound,
      hostCheck,
      originCheck,
      bodySizeGate,
      concurrencyGate,
      rateLimit,
      methodCheck,
      timeoutWare,
    ],
    clientIp,
    rateLimiterSize,
  };
}

export type { Request, Response };
