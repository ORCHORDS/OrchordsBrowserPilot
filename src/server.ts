import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { Config } from "./config.js";
import { createBrowserManager, type BrowserManager } from "./browser.js";
import { allTools, installBuffers, type ToolContext } from "./tools.js";

export { toolInputSchema };

export async function startStdio(config: Config): Promise<void> {
  const manager = createBrowserManager(config.browser.wsEndpoint, config.browser.headless);
  const server = buildServer(manager, {
    solver: { url: config.captcha.url, token: config.captcha.token },
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("orchords-web-pilot (stdio) ready");
}

export async function startHttp(config: Config): Promise<void> {
  const manager = createBrowserManager(config.browser.wsEndpoint, config.browser.headless);

  const app = express();
  app.use(express.json({ limit: "10mb" }));

  app.post(config.http.path, async (req, res) => {
    const transport = new StreamableHTTPServerTransport({
      // Stateless per-request session — fits an MCP gateway use case.
      sessionIdGenerator: undefined,
    });
    const server = buildServer(manager, {
      solver: { url: config.captcha.url, token: config.captcha.token },
    });
    res.on("close", () => transport.close().catch(() => undefined));
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.get(`${config.http.path}/health`, (_req, res) => {
    res.json({ ok: true, name: "orchords-web-pilot", transport: "http" });
  });

  app.listen(config.http.port, config.http.host, () => {
    console.error(`orchords-web-pilot (http) listening on http://${config.http.host}:${config.http.port}${config.http.path}`);
  });
}

function buildServer(manager: BrowserManager, extraCtx: Partial<ToolContext & { solver: { url?: string; token?: string } }>) {
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
    const page = await manager.page();
    await installBuffers(page);
    const ctx: ToolContext = { manager };
    try {
      const parsed = tool.schema.parse(args);
      const result = await tool.handler(parsed, { ...ctx, ...(extraCtx as object) });
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
