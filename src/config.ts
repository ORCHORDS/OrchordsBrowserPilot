import { z } from "zod";

const booleanFromString = z.union([z.boolean(), z.string()]).transform((v, ctx) => {
  if (typeof v === "boolean") return v;
  const normalized = v.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  ctx.addIssue({ code: z.ZodIssueCode.custom, message: "expected a boolean" });
  return z.NEVER;
});

const csvList = z.union([z.array(z.string()), z.string().optional()]).transform((v) => {
  if (!v) return undefined;
  const arr = Array.isArray(v)
    ? v
    : v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
  return arr.length > 0 ? arr : undefined;
});

const Config = z.object({
  transport: z.enum(["stdio", "http"]).default("stdio"),
  http: z
    .object({
      host: z.string().default("127.0.0.1"),
      port: z.coerce.number().int().positive().default(8788),
      path: z.string().default("/mcp"),
      allowedOrigins: csvList,
      allowedHosts: csvList,
      rateLimitPerMinute: z.coerce.number().int().positive().default(120),
      maxBodyKb: z.coerce.number().int().positive().max(10240).default(1024),
      requestTimeoutSec: z.coerce.number().int().positive().default(60),
      trustProxy: booleanFromString.default(false),
      allowPublicBind: booleanFromString.default(false),
    })
    .default({}),
  browser: z
    .object({
      headless: booleanFromString.default(true),
      wsEndpoint: z.string().optional(),
      /**
       * Issue #106 browser-process isolation policy.
       *
       * `trusted-local` preserves the current self-host/developer launch
       * posture and makes no claim that Chromium's process sandbox is active.
       * `require-chromium-sandbox` requests Chromium sandboxing and is
       * intended to fail closed when the host cannot provide it.
       */
      isolation: z
        .enum(["trusted-local", "require-chromium-sandbox"])
        .default("trusted-local"),
    })
    .default({}),
  captcha: z
    .object({
      url: z.string().optional(),
      token: z.string().optional(),
    })
    .default({}),
  policy: z
    .object({
      /**
       * Issue #81 action-policy checkpoint mode.
       *
       * - "audit" (default): every primitive action is classified and
       *   audited (envelope, digest, risk class, decision), approvals are
       *   validated and consumed when supplied, but a missing approval does
       *   not block dispatch. This is the explicit "local/unconstrained"
       *   role behavior, and the decision is separately auditable as such.
       * - "enforce": sensitive/irreversible actions are blocked unless a
       *   valid approval bound to the live envelope digest is presented.
       *   Required for constrained commercial roles/workspaces (RBAC #42).
       */
      mode: z.enum(["audit", "enforce"]).default("audit"),
    })
    .default({}),
  operations: z
    .object({
      /**
       * Issue #104 — per-session operation queue.
       *
       * `maxConcurrent` slots run at once per session; further callers
       * queue in FIFO order. Default 1 keeps the gate and the Playwright
       * page lockstep so the live snapshot taken for the TOCTOU check
       * matches the page state the handler actually navigates.
       *
       * `queueMax` caps the backlog; overflow returns immediately with a
       * structured 503-shaped error so the caller can back off instead of
       * deadlocking. Default 64.
       */
      maxConcurrent: z.coerce.number().int().positive().default(1),
      queueMax: z.coerce.number().int().nonnegative().default(64),
    })
    .default({}),
});

export type Config = z.infer<typeof Config>;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return Config.parse({
    transport: env.PILOT_TRANSPORT,
    http: {
      host: env.PILOT_HTTP_HOST,
      port: env.PILOT_HTTP_PORT,
      path: env.PILOT_HTTP_PATH,
      allowedOrigins: env.PILOT_HTTP_ALLOWED_ORIGINS,
      allowedHosts: env.PILOT_HTTP_ALLOWED_HOSTS,
      rateLimitPerMinute: env.PILOT_HTTP_RATE_LIMIT,
      maxBodyKb: env.PILOT_HTTP_MAX_BODY_KB,
      requestTimeoutSec: env.PILOT_HTTP_REQUEST_TIMEOUT_SEC,
      trustProxy: env.PILOT_HTTP_TRUST_PROXY,
      allowPublicBind: env.PILOT_HTTP_ALLOW_PUBLIC_BIND,
    },
    browser: {
      headless: env.PILOT_HEADLESS,
      wsEndpoint: env.BROWSER_WS_ENDPOINT,
      isolation: env.PILOT_BROWSER_ISOLATION,
    },
    captcha: {
      url: env.PILOT_CAPTCHA_SOLVER_URL,
      token: env.PILOT_CAPTCHA_SOLVER_TOKEN,
    },
    policy: {
      mode: env.PILOT_POLICY_MODE,
    },
    operations: {
      maxConcurrent: env.PILOT_OPS_MAX_CONCURRENT,
      queueMax: env.PILOT_OPS_QUEUE_MAX,
    },
  });
}
