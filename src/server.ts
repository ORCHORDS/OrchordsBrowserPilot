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
import {
  ActionGate,
  ApprovalStore,
  MemoryAuditSink,
  composeSinks,
  digestEnvelope,
  noopSink,
  summarizeEnvelope,
  type AuditKind,
  type LiveStateSnapshot,
  type ProposedActionEnvelope,
  policyTools,
} from "./policy/index.js";
import {
  OperationCancelledError,
  OperationQueueFullError,
  type OperationEvent,
} from "./operation-queue.js";

export { toolInputSchema };

/**
 * StdIO transport: single shared session, single client. We still wrap it
 * in a Session so console/network buffers don't leak across requests — but
 * the BrowserManager itself is reused for the lifetime of the process.
 */
export async function startStdio(config: Config): Promise<void> {
  const manager = createBrowserManager(config.browser.wsEndpoint, config.browser.headless);
  const solver = { url: config.captcha.url, token: config.captcha.token };
  const session = new Session("stdio", manager, {
    maxConcurrent: config.operations.maxConcurrent,
    queueMax: config.operations.queueMax,
  });
  const transport = new StdioServerTransport();
  const server = buildServer(session, solver, { policyMode: config.policy.mode });
  await server.connect(transport);
}

/** HTTP transport with DNS-rebinding / CSRF / abuse hardening (P0 #43). */
export async function startHttp(config: Config): Promise<void> {
  if (!isLoopbackHost(config.http.host) && !config.http.allowPublicBind) {
    throw new Error(
      `Refusing to bind HTTP transport to non-loopback host '${config.http.host}'. ` +
      `Set PILOT_HTTP_ALLOW_PUBLIC_BIND=true only behind authentication, TLS, and a trusted reverse proxy.`,
    );
  }

  const app = express();
  app.disable("x-powered-by");

  const allowedHosts = config.http.allowedHosts.length
    ? config.http.allowedHosts
    : defaultAllowedHosts(config.http.host, config.http.port);
  const allowedOrigins = config.http.allowedOrigins.length
    ? config.http.allowedOrigins
    : defaultAllowedOrigins(config.http.host, config.http.port);
  const hardening = buildHardening({
    allowedHosts,
    allowedOrigins,
    ratePerMinute: config.http.ratePerMinute,
    maxBodyBytes: config.http.maxBodyBytes,
    timeoutMs: config.http.timeoutMs,
    trustedProxies: config.http.trustedProxies,
    maxConcurrentRequests: config.http.maxConcurrentRequests,
  });

  // Security headers must apply to every response, including early rejection
  // paths from Host/Origin/rate/body/deadline middleware.
  app.use(hardening.securityHeaders);
  app.use(hardening.hostCheck);
  app.use(hardening.originCheck);
  app.use(hardening.rateLimit);
  app.use(hardening.concurrentAdmission);
  app.use(hardening.methodCheck);
  app.use(hardening.bodyLimit);
  app.use(hardening.timeout);
  app.use(express.json({ limit: config.http.maxBodyBytes }));

  const sessions = new SessionRegistry({
    idleMs: config.sessions.idleMs,
    create: (id) => new Session(
      id,
      createBrowserManager(config.browser.wsEndpoint, config.browser.headless),
      {
        maxConcurrent: config.operations.maxConcurrent,
        queueMax: config.operations.queueMax,
      },
    ),
  });
  const solver = { url: config.captcha.url, token: config.captcha.token };

  const sweep = setInterval(() => {
    void sessions.sweep();
  }, Math.min(config.sessions.idleMs, 60_000));
  sweep.unref();

  app.get("/health", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  app.post("/", async (req, res) => {
    const incomingSessionId = req.header("Mcp-Session-Id")?.trim();
    const sessionId = incomingSessionId || randomUUID();
    const session = sessions.getOrCreate(sessionId);
    session.touch();

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId,
      onsessioninitialized: () => undefined,
    });
    const server = buildServer(session, solver, { policyMode: config.policy.mode });

    res.on("close", () => {
      void transport.close().catch(() => undefined);
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        res.status(500).json({ error: "mcp_request_failed", message });
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    const server = app.listen(config.http.port, config.http.host, resolve);
    server.once("error", reject);
  });
}

type CaptchaSolver = { url?: string; token?: string };
type BuildServerOptions = { policyMode?: "off" | "audit" | "enforce" };

function buildServer(session: Session, captchaSolver: CaptchaSolver, options: BuildServerOptions = {}): Server {
  const server = new Server(
    { name: "orchords-web-pilot", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  const policyMode = options.policyMode ?? "off";
  const approvalStore = new ApprovalStore();
  const memoryAudit = new MemoryAuditSink();
  const audit = composeSinks(memoryAudit, noopSink);
  const gate = new ActionGate(approvalStore, audit, { mode: policyMode });
  const tools = [...allTools, ...policyTools];

  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: toolInputSchema(tool.schema),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name;
    const tool = toolMap.get(name);
    if (!tool) {
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }

    const rawArgs = asRecord(request.params.arguments);
    const approvalId = typeof rawArgs._approval === "string" ? rawArgs._approval : undefined;
    const proposalId = typeof rawArgs._proposalId === "string" ? rawArgs._proposalId : undefined;
    const toolArgs = stripReservedArgs(rawArgs);

    const operationSignal = (extra as { signal?: AbortSignal }).signal;
    const ctx: ToolContext = {
      session,
      get page() {
        return session.cachedPage();
      },
      captchaSolver,
      signal: operationSignal,
    };

    try {
      const parsed = tool.schema.parse(toolArgs);
      const toolRecord = asRecord(parsed);
      const initialSnapshot = await resolveLiveSnapshot(session, name, toolRecord);
      const decision = gate.propose({
        sessionId: session.id,
        tool: name,
        args: toolRecord,
        initialSnapshot,
        approvalId,
        proposalId,
      });

      const extendedCtx: ToolContext = {
        ...ctx,
        policy: {
          gate,
          decision,
          initialSnapshot,
          resolveLiveSnapshot: () => resolveLiveSnapshot(session, name, toolRecord),
        },
      };

      if (!decision.permitted && !decision.requiresApproval) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: false,
                error: "policy_denied",
                reason: decision.reason ?? "policy_denied",
                riskClass: decision.riskClass,
              }),
            },
          ],
          isError: true,
        };
      }

      if (decision.requiresApproval && !decision.permitted) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: false,
                error: "approval_required",
                reason: decision.reason ?? "approval_required",
                proposalId: decision.envelope.proposalId,
                envelopeDigest: decision.envelopeDigest,
                riskClass: decision.riskClass,
                requiresApproval: decision.requiresApproval,
                summary: summarize(decision.envelope),
              }),
            },
          ],
          isError: true,
        };
      }
      const result = await tool.handler(parsed, extendedCtx);
      gate.recordDispatch(
        {
          sessionId: session.id,
          tool: name,
          envelopeDigest: decision.envelopeDigest,
          proposalId: decision.envelope.proposalId,
        },
        decision.permitted
          ? { ok: true }
          : { ok: true, reason: "audited_without_approval", context: { policyMode } },
      );
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      gate.recordDispatch({ sessionId: session.id, tool: name }, { ok: false, reason: message });
      return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
    }
  });

  return server;
}

/**
 * Capture a live snapshot of the page for the gate's TOCTOU check.
 * Reads from the cached Playwright page when one exists; for tools that
 * don't need a page (read-only diagnostics), the snapshot is best-effort
 * empty and the classifier falls back to the tool's static risk class.
 */
async function resolveLiveSnapshot(
  session: Session,
  tool: string,
  _args: Record<string, unknown>,
): Promise<LiveStateSnapshot> {
  let pageUrl = "";
  let frameUrl = "";
  let effectiveUrl = "";
  let origin = "";
  try {
    const p = await session.page();
    if (p && !p.isClosed()) {
      effectiveUrl = p.url();
      const main = p.mainFrame();
      pageUrl = main.url();
      frameUrl = main.url();
      try {
        const u = new URL(effectiveUrl);
        // Opaque origins (`data:`, `about:`, `file:`) report `null`; leave
        // origin empty so the risk classifier falls back to effectiveUrl and
        // preserves its scheme-level risk instead of parsing a synthetic URL.
        origin = u.origin === "null" ? "" : u.origin;
      } catch {
        origin = "";
      }
    }
  } catch {
    // No page yet — that's fine for tools like browser_captcha_solve
    // that don't need one.
    void tool;
  }
  return { pageUrl, frameUrl, effectiveUrl, origin, liveSecretVersions: {} };
}

function summarize(env: ProposedActionEnvelope): string {
  return summarizeEnvelope(env);
}

function asRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
}

/**
 * Strip reserved arguments (`_approval`, `_proposalId`) before the
 * canonical envelope sees them. These are not part of the tool's
 * declared schema — they're policy plumbing — and including them would
 * pollute the digest.
 */
function stripReservedArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k === "_approval" || k === "_proposalId") continue;
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function toolInputSchema(schema: import("zod").ZodTypeAny): Record<string, unknown> {
  // Convert Zod to JSON Schema (draft-07 dialect — the broadest MCP-client support).
  // Primitive/property constraints stay generated from Zod. Cross-field constraints
  // that Zod `.refine()` cannot serialize are merged below using standard JSON Schema
  // composition, so MCP clients see the same target-mode contract as the runtime.
  const json = zodToJsonSchema(schema, { target: "jsonSchema7" }) as Record<string, unknown>;
  delete json.$schema;

  const toolName = allTools.find((tool) => tool.schema === schema)?.name;
  if (toolName === "browser_click") {
    json.oneOf = [
      {
        required: ["ref"],
        not: { anyOf: [{ required: ["selector"] }, { required: ["x"] }, { required: ["y"] }] },
      },
      {
        required: ["selector"],
        not: { anyOf: [{ required: ["ref"] }, { required: ["x"] }, { required: ["y"] }] },
      },
      {
        required: ["x", "y"],
        not: { anyOf: [{ required: ["ref"] }, { required: ["selector"] }] },
      },
    ];
  } else if (toolName === "browser_drag") {
    json.allOf = [
      { oneOf: [{ required: ["fromRef"] }, { required: ["fromSelector"] }] },
      { oneOf: [{ required: ["toRef"] }, { required: ["toSelector"] }] },
    ];
  }

  return json;
}

/** Map OperationEvent.kind → AuditKind so the audit log gets a unified view. */
function operationEventToAuditKind(kind: OperationEvent["kind"]): AuditKind {
  switch (kind) {
    case "queued":
      return "dispatch.queued";
    case "started":
      return "dispatch.started";
    case "completed":
      return "dispatch.completed";
    case "cancelled":
      return "dispatch.cancelled";
    case "overflow":
      return "dispatch.overflowed";
  }
}

/** Pull the OperationEvent fields that aren't on AuditEvent into `context`. */
function operationEventContext(ev: OperationEvent): Record<string, unknown> {
  const ctx: Record<string, unknown> = { opId: ev.opId };
  if (ev.kind === "queued") ctx.queueDepth = ev.queueDepth;
  if (ev.kind === "started") {
    ctx.inFlight = ev.inFlight;
    ctx.queueWaitMs = ev.queueWaitMs;
    ctx.dispatchSequence = ev.dispatchSequence;
  }
  if (ev.kind === "completed") {
    ctx.ok = ev.ok;
    ctx.ms = ev.ms;
  }
  if (ev.kind === "cancelled") {
    ctx.reason = ev.reason;
    ctx.code = ev.code;
  }
  if (ev.kind === "overflow") ctx.queueMax = ev.queueMax;
  return ctx;
}