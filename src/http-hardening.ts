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
  /** When true, always honor X-Forwarded-For. */
  trustProxy: boolean;
  /** When `trustProxy` is false, only honor X-Forwarded-For if the direct
   *  socket peer is in this set. Empty/undefined disables XFF entirely. */
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

function firstHeader(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v && v.length > 0 ? v : undefined;
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
 * Resolve the effective client IP for the given request.
 *
 * Algorithm:
 *   1. Read the socket's `remoteAddress` as the trust anchor.
 *   2. Decide whether to consult X-Forwarded-For:
 *      - trustProxy === true → always consult.
 *      - else if `trustedProxies` is set and contains the socket peer →
 *        consult (a known reverse proxy is in front).
 *      - else → ignore XFF entirely (untrusted peer cannot dictate it).
 *   3. If consulting XFF, split by comma and walk right-to-left. Each
 *      hop must be in `trustedProxies` to keep walking; the first
 *      hop not in the set is the effective client.
 *   4. Bound the chain by `maxForwardedHops`; longer chains are treated
 *      as malformed and the socket peer is returned.
 */
/**
 * Parse the X-Forwarded-For chain when policy allows consulting it.
 * Returns undefined when XFF must be ignored entirely (untrusted peer or
 * absent header); the chain otherwise, ordered client-first.
 */
function forwardedChain(req: RequestLike, trustProxy: boolean, trust: Set<string>): string[] | undefined {
  const socketIp = req.socket?.remoteAddress ?? "unknown";
  const canConsult = trustProxy || (trust.size > 0 && trust.has(socketIp));
  if (!canConsult) return undefined;
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
  trustedProxies: Set<string> | undefined,
  maxForwardedHops: number | undefined,
): (req: RequestLike) => string {
  const trust = trustedProxies ?? new Set<string>();
  const hopCap = maxForwardedHops ?? 32;
  return (req: RequestLike): string => {
    const socketIp = req.socket?.remoteAddress ?? "unknown";
    const chain = forwardedChain(req, trustProxy, trust);
    if (!chain) return socketIp;
    if (chain.length > hopCap) return socketIp;
    let lastTrusted = socketIp;
    let i = chain.length - 1;
    while (i >= 0) {
      const hop = chain[i]!;
      if (trust.has(hop) || trust.has(lastTrusted)) {
        lastTrusted = hop;
        i -= 1;
        continue;
      }
      return hop;
    }
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
  const clientIp = makeClientIp(opts.trustProxy, opts.trustedProxies, opts.maxForwardedHops);

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
  // hop cap is treated as malformed and rejected outright — falling back
  // to the socket peer would silently let a spoofer dictate their key.
  const forwardedBound: RequestHandler = (req, res, next) => {
    const chain = forwardedChain(req, opts.trustProxy, opts.trustedProxies ?? new Set<string>());
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
