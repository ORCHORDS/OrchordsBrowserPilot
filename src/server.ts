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
    ? new Set(config.http.allowedOrigins.map((o) => o.toLowerCase()))
    : defaultAllowedOrigins(config.http.host, config.http.port);
  const allowedHosts = config.http.allowedHosts
    ? new Set(config.http.allowedHosts.map((h) => h.toLowerCase()))
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
    const session = registry.getOrCreate(sessionId, (id) => {
      const manager = createBrowserManager(config.browser.wsEndpoint, config.browser.headless);
      return new Session(id, manager, {
        maxConcurrent: config.operations.maxConcurrent,
        queueMax: config.operations.queueMax,
      });
    });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId,
    });

    const server = buildServer(session, solver, { policyMode: config.policy.mode });
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
    // Sum per-session queue stats so the health endpoint exposes both
    // session count and live backpressure (issue #104).
    let inFlight = 0;
    let queued = 0;
    let overflowed = 0;
    let cancelled = 0;
    let completed = 0;
    for (const session of registry.all()) {
      const s = session.ops.stats();
      inFlight += s.inFlight;
      queued += s.queued;
      overflowed += s.overflowed;
      cancelled += s.cancelled;
      completed += s.completed;
    }
    res.json({
      ok: true,
      name: "orchords-web-pilot",
      transport: "http",
      sessions: registry.size(),
      queue: { inFlight, queued, overflowed, cancelled, completed },
    });
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
    console.error(
      `orchords-web-pilot (http) listening on http://${config.http.host}:${config.http.port}${config.http.path}`,
    );
  });
}

function headerString(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v && v.length > 0 ? v : undefined;
}

export function buildServer(
  session: Session,
  solver: { url?: string; token?: string },
  options: { policyMode?: "audit" | "enforce" } = {},
) {
  const policyMode = options.policyMode ?? "audit";
  const server = new Server(
    {
      name: "orchords-web-pilot",
      version: "0.1.0",
    },
    {
      capabilities: { tools: {} },
    },
  );

  // Policy layer (issue #81). Each session owns its own approval ledger
  // and proposal cache so disposal frees the in-memory state. The
  // `MemoryAuditSink` gives tests deterministic event capture; production
  // deployments swap it for a sink that forwards to OpenTelemetry / a
  // durable audit log (issue #52).
  const audit = new MemoryAuditSink();
  const approvals = new ApprovalStore();
  const gate = new ActionGate(approvals, composeSinks([noopSink, audit.asSink()]));
  const proposals = new Map<string, ProposedActionEnvelope>();

  // Issue #104 — wire the per-session operation queue's lifecycle into
  // the audit log so overflow, cancellation, and queueing transitions
  // are visible in the same stream as the policy events. The onEvent
  // hook is set at Session construction time so we re-bind here to the
  // local audit sink (each buildServer() owns its own MemoryAuditSink).
  session.ops.onEvent = (ev: OperationEvent) => {
    audit.emit({
      kind: operationEventToAuditKind(ev.kind),
      ts: Date.now(),
      sessionId: ev.sessionId,
      tool: ev.tool,
      context: operationEventContext(ev),
    });
  };

  /** Proposal and dispatch must observe the same server-owned live-state model. */
  const liveState = (tool: string, args: Record<string, unknown>): Promise<LiveStateSnapshot> =>
    resolveLiveSnapshot(session, tool, args);

  /**
   * Canonicalize primitive arguments through the primitive's real Zod schema.
   * Reserved policy plumbing is extracted/stripped before parsing because Zod
   * object schemas strip unknown keys by default; proposal and dispatch must
   * digest the same normalized argument bytes.
   */
  const normalizeActionArguments = (
    toolName: string,
    rawArgs: Record<string, unknown>,
  ): Record<string, unknown> => {
    const target = allTools.find((candidate) => candidate.name === toolName);
    if (!target) throw new Error(`Unknown primitive tool: ${toolName}`);
    const parsed = target.schema.parse(stripReservedArgs(rawArgs));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  };

  const policyToolsByName = new Map(policyTools.map((t) => [t.name, t]));
  const exposedTools = [...allTools, ...policyTools];

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: exposedTools.map((t: { name: string; description: string; schema: import("zod").ZodTypeAny }) => ({
      name: t.name,
      description: t.description,
      inputSchema: toolInputSchema(t.schema),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    const tool = exposedTools.find((t) => t.name === name);
    if (!tool) {
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }

    // Issue #104 — every tool call goes through the session's operation
    // queue. The MCP SDK v1 RequestHandlerExtra gives each request an
    // AbortSignal; passing it into the queue ensures sender cancellation
    // can remove work that has not started. Once dispatch begins, running
    // browser/provider work must consume the signal cooperatively (#36).
    try {
      return await session.ops.run(name, () => dispatchTool(name, tool, args, request), {
        signal: extra.signal,
      });
    } catch (err) {
      if (err instanceof OperationQueueFullError) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: false,
                error: "queue_full",
                reason: err.message,
                queueMax: err.queueMax,
                opId: err.opId,
                tool: err.tool,
              }),
            },
          ],
          isError: true,
        };
      }
      if (err instanceof OperationCancelledError) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: false,
                error: err.code,
                reason: err.reason,
                opId: err.opId,
                tool: err.tool,
              }),
            },
          ],
          isError: true,
        };
      }
      throw err;
    }
  });

  // The actual gate+handler body lives in its own function so the queue
  // wrap above stays trivial — `dispatchTool` either resolves with a
  // CallToolResult or throws a structured Error.
  async function dispatchTool(
    name: string,
    tool: { schema: import("zod").ZodTypeAny; handler: (parsed: unknown, ctx: ToolContext) => Promise<unknown> },
    args: unknown,
    _request: unknown,
  ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    // Policy tools (propose / approve) carry the gate as part of their
    // tool context so they can record proposals / mint approval rows.
    if (policyToolsByName.has(name)) {
      const baseCtx: ToolContext = { session };
      try {
        const parsed = tool.schema.parse(args);
        // Cache the proposal after a successful `propose` so the
        // matching `approve` call can resolve envelopeDigest -> envelope.
        const result = (await tool.handler(parsed, {
          ...baseCtx,
          gate,
          liveState,
          normalizeActionArguments,
          proposals,
          approverId: "user",
        } as ToolContext)) as { proposalId?: string; envelope?: ProposedActionEnvelope };
        if (name === "browser_propose_action" && result?.proposalId && result.envelope) {
          proposals.set(result.proposalId, result.envelope);
          if (proposals.size > 200) {
            // Trim oldest to bound memory — proposals are short-lived.
            const first = proposals.keys().next().value;
            if (first) proposals.delete(first);
          }
        }
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
      }
    }

    // Primitive tools: gate classifies the call before invoking the
    // handler. Sensitive / irreversible actions require an approval id
    // bound to the live envelope digest; the gate re-derives the
    // envelope from current page state and refuses dispatch on any
    // mismatch (TOCTOU).
    const baseCtx: ToolContext = { session };
    const extendedCtx = { ...baseCtx, solver } as ToolContext & { solver: typeof solver };
    try {
      const rawArgs = asRecord(args);
      const approvalId = typeof rawArgs._approval === "string" ? rawArgs._approval : undefined;
      const proposalId = typeof rawArgs._proposalId === "string" ? rawArgs._proposalId : undefined;
      const argsRecord = normalizeActionArguments(name, rawArgs);
      const parsed = argsRecord;
      const live = await resolveLiveSnapshot(session, name, argsRecord);

      // Use the cached proposal envelope when present; otherwise mint an
      // ad-hoc one with the supplied proposalId so the gate's TOCTOU
      // recompute uses a stable id.
      let proposal: ProposedActionEnvelope | undefined = proposalId ? proposals.get(proposalId) : undefined;
      if (!proposal) {
        proposal = gate.propose({
          sessionId: session.id,
          tool: name,
          arguments: argsRecord,
          live,
          proposalId,
        }).envelope;
        if (proposalId) proposals.set(proposalId, proposal);
      }

      const decision = gate.gate({
        sessionId: session.id,
        tool: name,
        arguments: argsRecord,
        approvalId,
        live,
        proposal,
        proposalEnvelopeDigest: digestEnvelope(proposal),
      });
      // Audit mode (issue #81): a missing approval is recorded and flagged
      // in the response but does NOT block dispatch — this is the explicit
      // "unconstrained/local" role behavior. Every other denial (tool
      // denied by policy, envelope tampering/TOCTOU, secret-version drift,
      // invalid/expired/rejected approval) blocks in every mode: those are
      // integrity failures, not permission gaps.
      const blocked =
        !decision.permitted && !(policyMode === "audit" && decision.reason === "approval_missing");
      if (blocked) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: false,
                blocked: true,
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
  }

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
  // MCP currently requires a top-level object schema for tool inputs. Zod
  // unions correctly serialize their target-mode semantics as `anyOf`, but
  // that leaves `type` and the combined property catalog on the branches.
  // Lift only that structural metadata to the root; semantic validation stays
  // entirely in the generated branches so runtime and wire share one owner.
  const json = zodToJsonSchema(schema, { target: "jsonSchema7" }) as Record<string, unknown>;
  delete json.$schema;

  if (json.type !== "object" && Array.isArray(json.anyOf)) {
    const branches = json.anyOf.filter(
      (branch): branch is Record<string, unknown> =>
        Boolean(branch) && typeof branch === "object" && !Array.isArray(branch),
    );
    if (branches.length === json.anyOf.length && branches.every((branch) => branch.type === "object")) {
      const properties: Record<string, unknown> = {};
      for (const branch of branches) {
        const branchProperties = branch.properties;
        if (branchProperties && typeof branchProperties === "object" && !Array.isArray(branchProperties)) {
          Object.assign(properties, branchProperties);
        }
      }
      json.type = "object";
      json.properties = properties;
    }
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
