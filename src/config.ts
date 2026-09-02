import { z } from "zod";

const booleanFromString = z
  .union([z.boolean(), z.string()])
  .transform((v, ctx) => {
    if (typeof v === "boolean") return v;
    const normalized = v.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "expected a boolean" });
    return z.NEVER;
  });

const csvList = z
  .union([z.array(z.string()), z.string().optional()])
  .transform(v => {
    if (!v) return undefined;
    const arr = Array.isArray(v) ? v : v.split(",").map(s => s.trim()).filter(Boolean);
    return arr.length > 0 ? arr : undefined;
  });

const Config = z.object({
  transport: z.enum(["stdio", "http"]).default("stdio"),
  http: z.object({
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
  }).default({}),
  browser: z.object({
    headless: booleanFromString.default(true),
    wsEndpoint: z.string().optional(),
  }).default({}),
  captcha: z.object({
    url: z.string().optional(),
    token: z.string().optional(),
  }).default({}),
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
    },
    captcha: {
      url: env.PILOT_CAPTCHA_SOLVER_URL,
      token: env.PILOT_CAPTCHA_SOLVER_TOKEN,
    },
  });
}