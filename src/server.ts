import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { Config } from "./config.js";
import { isLoopbackHost } from "./config.js";
import { createBrowserManager } from "./browser.js";
import { allTools, type ToolContext } from "./tools.js";
import { Session, SessionRegistry } from "./session.js";
import { buildHardening, defaultAllowedHosts, defaultAllowedOrigins } from "./http-hardening.js";

export { toolInputSchema };

/**
 * StdIO transport: single shared session, single client. We still wrap it
 * in a Session so console/network buffers don't leak across requests — but
 * the BrowserManager itself is reused for the lifetime of the process.
 */
export async function startStdio(config: Config): Promise<void> {
  const manager = createBrowserManager(config.browser.wsEndpoint, config.browser.headless);
  const solver = { url: config.captcha.url, token: config.captcha.token };
  const session = new Session("stdio", manager);
  const transport = new StdioServerTransport();
  const server = buildServer(session, solver);
  await server.connect(transport);
  console.error("orchords-web-pilot (stdio) ready");

  const shutdown = async () => {
    await session.dispose();
    await manager.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * HTTP transport: each Mcp-Session-Id maps to its own Session. Requests
 * without a session id get a fresh session that lives only for the request
 * lifetime (no id is returned to the client, so the client cannot reuse it).
 *
 * The SessionRegistry is the single point that owns BrowserManager
 * instances — we share one across sessions that share the same id so
 * navigate -> snapshot -> click sequences see a stable page, and dispose
 * the manager when no session still references it.
 */
export async function startHttp(config: Config): Promise<void> {
  const solver = { url: config.captcha.url, token: config.captcha.token };
  const registry = new SessionRegistry();

  // Safe-by-default bind check (issue #43): binding a non-loopback address
  // without PILOT_HTTP_ALLOW_PUBLIC_BIND is almost always a mistake — the
  // endpoint drives a browser and has no authentication yet (#42).
  if (!config.http.allowPublicBind && !isLoopbackHost(config.http.host) && config.http.host !== "0.0.0.0") {
    throw new Error(
      `Refusing to bind non-loopback host ${config.http.host}. ` +
        "Set PILOT_HTTP_ALLOW_PUBLIC_BIND=true if this is intentional, and " +
        "put an authenticating reverse proxy (see issue #42) in front.",
    );
  }
  if (!config.http.allowPublicBind && config.http.host === "0.0.0.0") {
    throw new Error(
      "Refusing to bind 0.0.0.0 without authentication. Set PILOT_HTTP_ALLOW_PUBLIC_BIND=true " +
        "(and front the server with an authenticating proxy) to override.",
    );
  }

  const allowedOrigins = config.http.allowedOrigins
    ? new Set(config.http.allowedOrigins.map(o => o.toLowerCase()))
    : defaultAllowedOrigins(config.http.host, config.http.port);
  const allowedHosts = config.http.allowedHosts
    ? new Set(config.http.allowedHosts.map(h => h.toLowerCase()))
    : defaultAllowedHosts(config.http.host);

  const { stack } = buildHardening({
    allowedOrigins,
    allowedHosts,
    rateLimitPerMinute: config.http.rateLimitPerMinute,
    maxBodyBytes: config.http.maxBodyKb * 1024,
    requestTimeoutMs: config.http.requestTimeoutSec * 1000,
    trustProxy: config.http.trustProxy,
  });

  const app = express();
  app.use(stack);
  app.use(express.json({ limit: `${config.http.maxBodyKb}kb` }));

  app.post(config.http.path, async (req, res) => {
    const incomingId = headerString(req.headers["mcp-session-id"]);
    const sessionId = incomingId ?? randomUUID();
    const session = registry.getOrCreate(sessionId, id => {
      const manager = createBrowserManager(config.browser.wsEndpoint, config.browser.headless);
      return new Session(id, manager);
    });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId,
    });

    const server = buildServer(session, solver);
    res.on("close", () => {
      transport.close().catch(() => undefined);
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } finally {
      // If the request did NOT advertise a session id (stateless gateway
      // mode), drop the freshly created session so it doesn't pin a browser
      // forever. Reused sessions are kept alive by their lastUsed timestamp.
      if (!incomingId) {
        await registry.dispose(sessionId).catch(() => undefined);
      }
    }
  });

  app.get(`${config.http.path}/health`, (_req, res) => {
    res.json({ ok: true, name: "orchords-web-pilot", transport: "http", sessions: registry.size() });
  });

  // Periodically sweep idle sessions — at most once a minute.
  const sweep = setInterval(() => {
    registry.sweep().catch(() => undefined);
  }, 60_000);
  sweep.unref();

  const shutdown = async () => {
    clearInterval(sweep);
    await registry.disposeAll();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  app.listen(config.http.port, config.http.host, () => {
    console.error(`orchords-web-pilot (http) listening on http://${config.http.host}:${config.http.port}${config.http.path}`);
  });
}

function headerString(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v && v.length > 0 ? v : undefined;
}

function buildServer(session: Session, solver: { url?: string; token?: string }) {
  const server = new Server(
    {
      name: "orchords-web-pilot",
      version: "0.1.0",
    },
    {
      capabilities: { tools: {} },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: toolInputSchema(t.schema),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = allTools.find(t => t.name === name);
    if (!tool) {
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
    const ctx: ToolContext = { session };
    try {
      const parsed = tool.schema.parse(args);
      const result = await tool.handler(parsed, { ...ctx, solver } as ToolContext & { solver: typeof solver });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
    }
  });

  return server;
}

function toolInputSchema(schema: import("zod").ZodTypeAny): Record<string, unknown> {
  // Convert Zod to JSON Schema (draft-07 dialect — the broadest MCP-client support).
  // The result already satisfies the MCP SDK's `inputSchema` shape: type "object"
  // plus optional properties/required plus extras like enum/default/format/minimum
  // for primitives. We drop the auto-injected $schema so it doesn't clutter the wire.
  const json = zodToJsonSchema(schema, { target: "jsonSchema7" }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}