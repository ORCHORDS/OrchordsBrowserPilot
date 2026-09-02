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

const Config = z.object({
  transport: z.enum(["stdio", "http"]).default("stdio"),
  http: z.object({
    host: z.string().default("127.0.0.1"),
    port: z.coerce.number().int().positive().default(8788),
    path: z.string().default("/mcp"),
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return Config.parse({
    transport: env.PILOT_TRANSPORT,
    http: {
      host: env.PILOT_HTTP_HOST,
      port: env.PILOT_HTTP_PORT,
      path: env.PILOT_HTTP_PATH,
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
