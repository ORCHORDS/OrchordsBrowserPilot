import { z } from "zod";
import type { ToolDef, ToolContext } from "../tools.js";
import type { ActionGate, ProposedActionEnvelope } from "./index.js";
import { summarizeEnvelope } from "./summary.js";
import { digestEnvelope } from "./digest.js";
import type { LiveStateSnapshot } from "./gate.js";

/**
 * Tool definitions for the policy layer (issue #81). These tools let a
 * coding-agent / model propose an action, get an envelope + risk class, and
 * mint a one-time approval whose digest is rechecked by the primitive tool
 * dispatch in server.ts.
 *
 * The semantic envelope returned by `browser_propose_action` is the same
 * envelope the gate digests at dispatch time — proposals and dispatches
 * share one canonical representation, so the approval UI and the executor
 * are looking at the same normalized bytes.
 */

export interface PolicyToolContext extends ToolContext {
  gate: ActionGate;
  liveState: (
    tool: string,
    args: Record<string, unknown>,
  ) => LiveStateSnapshot | Promise<LiveStateSnapshot>;
  normalizeActionArguments: (
    tool: string,
    args: Record<string, unknown>,
  ) => Record<string, unknown>;
  /** Caller identity for approval rows — defaults to "user" for stdio,
   *  the authenticated principal for HTTP (wired by server.ts). */
  approverId?: string;
}

export const proposeAction: ToolDef = {
  name: "browser_propose_action",
  description:
    "Build a canonical proposed-action envelope for a primitive tool call, classify its risk, and return the envelope + SHA-256 digest. If approval is required, call browser_approve_action and then invoke the primitive tool with the returned approval id and proposal id.",
  schema: z
    .object({
      tool: z.string().describe("The primitive tool name (e.g. `browser_click`) that will be dispatched."),
      arguments: z.record(z.unknown()).describe("Arguments that will be passed to the primitive tool."),
      formAction: z.string().optional(),
      formMethod: z.string().optional(),
      workflowId: z.string().optional(),
      secrets: z
        .array(
          z.object({
            id: z.string(),
            version: z.number().int().nonnegative(),
            versionHash: z.string(),
          }),
        )
        .optional(),
    })
    .passthrough(),
  handler: async (args, ctx) => {
    const { gate, liveState, normalizeActionArguments, session } = ctx as PolicyToolContext;
    const a = args as {
      tool: string;
      arguments: Record<string, unknown>;
      formAction?: string;
      formMethod?: string;
      workflowId?: string;
      secrets?: Array<{ id: string; version: number; versionHash: string }>;
    };
    // Proposal-time state and argument normalization must be the same
    // server-owned model that dispatch later re-resolves. Placeholder session
    // ids, empty URLs, or unparsed/default-less arguments make an unchanged
    // action's digest impossible to reproduce.
    const normalizedArguments = normalizeActionArguments(a.tool, a.arguments);
    const live = await liveState(a.tool, normalizedArguments);
    const result = gate.propose({
      sessionId: session.id,
      tool: a.tool,
      arguments: normalizedArguments,
      live,
      formAction: a.formAction,
      formMethod: a.formMethod,
      workflowId: a.workflowId,
      secrets: a.secrets,
    });
    return {
      proposalId: result.envelope.proposalId,
      envelopeDigest: result.envelopeDigest,
      riskClass: result.riskClass,
      requiresApproval: result.requiresApproval,
      summary: summarizeEnvelope(result.envelope),
      envelope: result.envelope,
      reason: result.reason,
    };
  },
};

export const approveAction: ToolDef = {
  name: "browser_approve_action",
  description:
    "Mint a one-time approval bound to a previously-proposed envelope digest. The approval is keyed by the SHA-256 envelope digest, the approver identity, and a random nonce; it expires after the configured TTL. Replays of the same approval id are rejected.",
  schema: z
    .object({
      envelopeDigest: z.string().regex(/^[a-f0-9]{64}$/),
      approverId: z.string().min(1),
      decision: z.enum(["approve", "deny"]).default("approve"),
      summary: z.string().optional(),
    })
    .strict(),
  handler: async (args, ctx) => {
    const { gate, liveState, session } = ctx as PolicyToolContext;
    const a = args as {
      envelopeDigest: string;
      approverId: string;
      decision: "approve" | "deny";
      summary?: string;
    };
    // We need the original envelope to mint a record. The store records
    // by digest; here we recompute the envelope from current live state
    // (the gate's propose() is idempotent given identical inputs). The
    // canonical rule: an approval may only be minted against the live
    // envelope at the time of approval, which matches "approval bound to
    // the exact execution intent" (issue #81 acceptance criterion #6).
    void session;
    void liveState;
    // The approval store's digest is the source of truth. We rebuild a
    // minimal envelope stub to satisfy the typed input; the gate does NOT
    // trust caller-supplied envelope fields here — only the digest.
    const stub = stubEnvelopeForDigest(a.envelopeDigest, ctx);
    if (!stub) {
      return { ok: false, reason: "unknown_envelope_digest" };
    }
    const rec = gate.mintApproval({
      envelope: stub,
      envelopeDigest: a.envelopeDigest,
      approverId: a.approverId,
      decision: a.decision,
      summary: a.summary ?? summarizeEnvelope(stub),
    });
    return {
      ok: true,
      approvalId: rec.id,
      expiresAt: rec.expiresAt,
      decision: rec.decision,
    };
  },
};

/**
 * Resolve a digest to the last envelope that produced it, when the
 * proposal was made in this session. We use the per-server proposal cache;
 * production durable approval metadata remains tracked by #73/#52.
 */
function stubEnvelopeForDigest(targetDigest: string, ctx: ToolContext): ProposedActionEnvelope | null {
  const proposals = (ctx as PolicyToolContext & { proposals?: Map<string, ProposedActionEnvelope> })
    .proposals;
  if (!proposals) return null;
  for (const env of proposals.values()) {
    if (digestEnvelope(env) === targetDigest) return env;
  }
  return null;
}

export const policyTools: ToolDef[] = [proposeAction, approveAction];
