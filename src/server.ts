import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import express from "express";

import type { Config } from "./config.js";
import { createBrowserManager, type BrowserManager } from "./browser.js";
import { allTools, installBuffers, type ToolContext } from "./tools.js";

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
      inputSchema: zodToJsonSchema(t.schema),
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

function zodToJsonSchema(schema: unknown): unknown {
  // Minimal passthrough — the MCP SDK accepts Zod schemas as JSON Schema roughly OK
  // for simple objects. For a polished public release, swap in zod-to-json-schema.
  const s = schema as { _def?: { typeName?: string; schema?: { _def?: { typeName?: string; shape?: () => Record<string, unknown> } } } };
  if (s?._def?.typeName === "ZodObject" && s._def.schema?._def?.shape) {
    const shape = s._def.schema._def.shape();
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [k, v] of Object.entries(shape)) {
      const def = (v as { _def?: { typeName?: string; description?: string } })._def;
      properties[k] = { type: jsonType(def?.typeName) };
      if (def?.description) (properties[k] as Record<string, unknown>).description = def.description;
      required.push(k);
    }
    return { type: "object", properties, required };
  }
  return { type: "object", additionalProperties: true };
}

function jsonType(typeName?: string): string {
  switch (typeName) {
    case "ZodString": return "string";
    case "ZodNumber": return "number";
    case "ZodBoolean": return "boolean";
    case "ZodArray": return "array";
    case "ZodEnum": return "string";
    default: return "string";
  }
}
