import { randomUUID } from "node:crypto";

import type { AuditSink } from "./audit.js";
import { ENVELOPE_VERSION, type ProposedActionEnvelope, type RiskClass } from "./envelope.js";
import { digestEnvelope } from "./digest.js";
import { classifyRisk } from "./risk.js";
import { ApprovalStore, type ApprovalRecord } from "./approval.js";
import {
  PolicyDecisionEngine,
  type PolicyDecision,
  type PolicyInputs,
} from "./decision.js";

/**
 * Snapshot of the live page state used to build a dispatch-time envelope
 * and recompute its digest. The gate compares this against the
 * proposal-time snapshot embedded in the envelope; any difference fails
 * the TOCTOU check.
 *
 * The interface is intentionally narrow so adapters / semantic layers
 * (Playwright, a remote-browser provider, a recording layer) can fill it
 * from their own state without coupling to Playwright types.
 */
export interface LiveStateSnapshot {
  pageUrl: string;
  frameUrl: string;
  effectiveUrl: string;
  origin: string;
  /** Map of secret id -> current version observed at dispatch time. */
  liveSecretVersions: Record<string, number>;
  /** Optional target fingerprint snapshot for ref/selector targets. */
  targetFingerprint?: string;
}

export interface GateInputs {
  sessionId: string;
  tool: string;
  arguments: Record<string, unknown>;
  /** Caller-supplied approval id; required for sensitive/irreversible calls. */
  approvalId?: string;
  /** Optional explicit workflow id when the action came from a workflow run. */
  workflowId?: string;
  /** Snapshot of the live page at proposal time. */
  live: LiveStateSnapshot;
  /** Form metadata when the action targets a form (POST etc.). */
  formAction?: string;
  formMethod?: string;
  /** Precomputed secrets consumed by this action (id + version + hash). */
  secrets?: Array<{ id: string; version: number; versionHash: string }>;
  /** Optional proposal id — when provided, the envelope reuses this id
   *  instead of generating a new one. Required when the same envelope
   *  must be reproduced for a dispatch-time TOCTOU recheck. */
  proposalId?: string;
  /** The proposal envelope returned by an earlier `propose()` call.
   *  When supplied, `gate()` uses it as the source of truth for risk
   *  class, target, secrets, and arguments — fields that the caller
   *  may have intentionally pinned at proposal time. The envelope is
   *  NOT re-built; only the digest is recomputed from live state to
   *  verify TOCTOU. */
  proposal?: ProposedActionEnvelope;
  /** Precomputed digest of the supplied proposal envelope. Computed by
   *  the caller once and used to compare against the live-state digest. */
  proposalEnvelopeDigest?: string;
  /** Injectable clock for tests. */
  now?: () => number;
}

export interface GateResult {
  /** The canonical envelope (rebuilt from live state at dispatch time). */
  envelope: ProposedActionEnvelope;
  /** SHA-256 over the canonical envelope. */
  envelopeDigest: string;
  /** Risk class assigned by the classifier. */
  riskClass: RiskClass;
  /** True when the dispatch is permitted (allow + valid approval). */
  permitted: boolean;
  /** True when the caller must obtain approval before retrying. */
  requiresApproval: boolean;
  /** Reason the gate refused, if any. */
  reason?: string;
  /** The approval record consumed (if any). */
  approval?: ApprovalRecord;
}

/**
 * The default policy threshold: tools classified `read` are allowed
 * without approval; `mutate` is allowed (the human is driving the
 * browser and visible clicks are inherently user-driven); `sensitive` and
 * `irreversible` require an approval. The exact threshold is configured
 * by the workspace role (see #42) — when role is `unsafe-admin` even
 * sensitive calls are allowed, but every call is still audited.
 */
export interface GatePolicy {
  requireApprovalFor: (r: RiskClass) => boolean;
  /** TTL of minted approvals (ms). */
  approvalTtlMs: number;
  /** Hard deny list — these tools never run regardless of approval. */
  denyTools?: Set<string>;
  /** Optional role id, recorded in approval rows and audit events. */
  policyId?: string;
}

export const DEFAULT_POLICY: GatePolicy = {
  requireApprovalFor: (r) => r === "irreversible" || r === "sensitive",
  approvalTtlMs: 5 * 60_000,
};

/**
 * Action gate. Construct one per session — the audit/approval store is
 * session-scoped so disposal frees all in-memory state.
 *
 * Two entry points:
 *   - `propose` — called by semantic / workflow tools. Returns the
 *     envelope and digest for the proposal; if approval is required the
 *     `requiresApproval` flag is set and the dispatch must wait.
 *   - `gate` — called by the dispatch path immediately before the tool
 *     handler runs. Recomputes the envelope from live state, validates
 *     the approval, audits the outcome, and returns whether the dispatch
 *     is permitted.
 */
export class ActionGate {
  private readonly decisionEngine: PolicyDecisionEngine;

  constructor(
    private readonly approvals: ApprovalStore,
    private readonly audit: AuditSink,
    private readonly policy: GatePolicy = DEFAULT_POLICY,
    decisionEngine?: PolicyDecisionEngine,
  ) {
    this.decisionEngine = decisionEngine ?? new PolicyDecisionEngine();
  }

  /**
   * Consult the versioned policy decision engine. The gate's GatePolicy
   * is the *baseline* (read = allow, mutate = allow, sensitive/irreversible
   * = approval). The engine layers auth + egress + capability + dataflow
   * controls on top, so e.g. an irreversible action with no
   * `capability:irreversible` scope refuses BEFORE the approval row is
   * minted. Returns the full decision so callers can include it in the
   * audit context.
   */
  decide(inputs: PolicyInputs): PolicyDecision {
    return this.decisionEngine.decide(inputs);
  }

  /** Engine version the gate is currently using (audit-friendly). */
  policyVersion(): number {
    return this.decisionEngine.policyVersion;
  }

  /**
   * Classify a proposed action. Returns the envelope + digest + risk +
   * whether approval is required. The proposal itself is NOT stored
   * anywhere — the gate only records approval / dispatch events; the
   * envelope lives in memory at the call site until the user approves.
   */
  propose(inputs: GateInputs): GateResult {
    const live = inputs.live;
    const risk = classifyRisk(inputs.tool, {
      effectiveUrl: live.effectiveUrl,
      origin: live.origin,
      formAction: inputs.formAction,
      formMethod: inputs.formMethod,
      arguments: inputs.arguments,
    });

    const envelope: ProposedActionEnvelope = {
      version: ENVELOPE_VERSION,
      proposalId: inputs.proposalId ?? randomUUID(),
      tool: inputs.tool,
      sessionId: inputs.sessionId,
      pageUrl: live.pageUrl,
      frameUrl: live.frameUrl,
      effectiveUrl: live.effectiveUrl,
      origin: live.origin,
      target: pickTarget(inputs.arguments),
      arguments: redactSecrets(inputs.arguments),
      secrets: (inputs.secrets ?? []).map((s) => ({
        id: s.id,
        version: s.version,
        versionHash: s.versionHash,
      })),
      riskClass: risk,
      workflow: inputs.workflowId ? { id: inputs.workflowId, expectedRisk: risk } : undefined,
      preconditions: [
        {
          kind: "page.url",
          digest: simpleHash(`${live.pageUrl}|${live.frameUrl}`),
          note: `${safeUrlForSummary(live.pageUrl)} @ ${safeUrlForSummary(live.frameUrl)}`,
        },
        ...(live.targetFingerprint ? [{ kind: "target.fingerprint", digest: live.targetFingerprint }] : []),
        ...Object.entries(live.liveSecretVersions).map(([id, version]) => ({
          kind: "secret.version",
          digest: simpleHash(`${id}@${version}`),
          note: id,
        })),
      ],
      proposedAt: (inputs.now ?? Date.now)(),
    };

    const envelopeDigest = digestEnvelope(envelope);
    const denied = this.policy.denyTools?.has(inputs.tool) ?? false;
    const requiresApproval = !denied && this.policy.requireApprovalFor(risk);

    this.audit({
      kind: "proposal.classified",
      ts: envelope.proposedAt,
      sessionId: inputs.sessionId,
      proposalId: envelope.proposalId,
      tool: inputs.tool,
      envelopeDigest,
      riskClass: risk,
      policyId: this.policy.policyId,
      outcome: denied ? "denied" : requiresApproval ? undefined : "ok",
      reason: denied ? "tool_denied_by_policy" : undefined,
    });

    if (denied) {
      return {
        envelope,
        envelopeDigest,
        riskClass: risk,
        permitted: false,
        requiresApproval: false,
        reason: "tool_denied_by_policy",
      };
    }
    return {
      envelope,
      envelopeDigest,
      riskClass: risk,
      permitted: !requiresApproval,
      requiresApproval,
    };
  }

  /**
   * Gate a dispatch. Validates the proposal against live state and
   * consumes the approval. The caller supplies the proposal envelope
   * returned by `propose` (or the digest + proposal id) so the dispatch
   * path doesn't have to rebuild it; rebuilding would change the random
   * proposalId and invalidate the digest.
   *
   * Validates, in order:
   *   1. tool is not on the deny list (immediate refusal),
   *   2. secret versions referenced by the proposal match the live
   *      secret store (rotation invalidates the approval BEFORE we burn
   *      it on a TOCTOU mismatch — so the audit log records the
   *      specific reason instead of a generic digest mismatch),
   *   3. the live envelope digest equals the proposal digest (TOCTOU),
   *   4. risk class has not been silently downgraded (enforced in
   *      `approvals.consume`),
   *   5. approval (if required) is present, not consumed, not expired,
   *      bound to the live envelope digest, and recorded by an
   *      authenticated approver.
   *
   * On success the dispatch proceeds; the caller invokes the tool
   * handler and then reports the outcome via `recordDispatch`.
   */
  gate(
    inputs: GateInputs & { proposal: ProposedActionEnvelope; proposalEnvelopeDigest: string },
  ): GateResult {
    const original = inputs.proposalEnvelopeDigest;

    const denied = this.policy.denyTools?.has(inputs.tool) ?? false;
    if (denied) {
      this.audit({
        kind: "approval.rejected",
        ts: (inputs.now ?? Date.now)(),
        sessionId: inputs.sessionId,
        proposalId: inputs.proposal.proposalId,
        envelopeDigest: original,
        reason: "tool_denied_by_policy",
        policyId: this.policy.policyId,
      });
      return {
        envelope: inputs.proposal,
        envelopeDigest: original,
        riskClass: inputs.proposal.riskClass,
        permitted: false,
        requiresApproval: false,
        reason: "tool_denied_by_policy",
      };
    }

    // Secret-version check first so the audit log gets a precise reason.
    for (const ref of inputs.proposal.secrets) {
      const liveVersion = inputs.live.liveSecretVersions[ref.id];
      if (liveVersion === undefined || liveVersion !== ref.version) {
        this.audit({
          kind: "approval.rejected",
          ts: (inputs.now ?? Date.now)(),
          sessionId: inputs.sessionId,
          proposalId: inputs.proposal.proposalId,
          envelopeDigest: original,
          reason: "secret_version_drift",
          policyId: this.policy.policyId,
        });
        return {
          envelope: inputs.proposal,
          envelopeDigest: original,
          riskClass: inputs.proposal.riskClass,
          permitted: false,
          requiresApproval: false,
          reason: "secret_version_drift",
        };
      }
    }

    const liveDigest = this.computeDigestForLiveState(inputs);
    if (liveDigest !== original) {
      this.audit({
        kind: "approval.rejected",
        ts: (inputs.now ?? Date.now)(),
        sessionId: inputs.sessionId,
        proposalId: inputs.proposal.proposalId,
        envelopeDigest: original,
        reason: "envelope_changed",
        policyId: this.policy.policyId,
      });
      return {
        envelope: inputs.proposal,
        envelopeDigest: original,
        riskClass: inputs.proposal.riskClass,
        permitted: false,
        requiresApproval: false,
        reason: "envelope_changed",
      };
    }

    if (!this.policy.requireApprovalFor(inputs.proposal.riskClass)) {
      return {
        envelope: inputs.proposal,
        envelopeDigest: original,
        riskClass: inputs.proposal.riskClass,
        permitted: true,
        requiresApproval: false,
      };
    }

    if (!inputs.approvalId) {
      this.audit({
        kind: "approval.rejected",
        ts: (inputs.now ?? Date.now)(),
        sessionId: inputs.sessionId,
        proposalId: inputs.proposal.proposalId,
        envelopeDigest: original,
        reason: "approval_missing",
        policyId: this.policy.policyId,
      });
      return {
        envelope: inputs.proposal,
        envelopeDigest: original,
        riskClass: inputs.proposal.riskClass,
        permitted: false,
        requiresApproval: true,
        reason: "approval_missing",
      };
    }

    const consumed = this.approvals.consume({
      approvalId: inputs.approvalId,
      envelopeDigest: original,
      riskClass: inputs.proposal.riskClass,
      liveSecretVersions: inputs.live.liveSecretVersions,
      now: inputs.now,
    });

    if (!consumed.ok) {
      this.audit({
        kind: "approval.rejected",
        ts: (inputs.now ?? Date.now)(),
        sessionId: inputs.sessionId,
        proposalId: inputs.proposal.proposalId,
        envelopeDigest: original,
        reason: consumed.reason,
        policyId: this.policy.policyId,
      });
      return {
        envelope: inputs.proposal,
        envelopeDigest: original,
        riskClass: inputs.proposal.riskClass,
        permitted: false,
        requiresApproval: true,
        reason: consumed.reason,
      };
    }

    this.audit({
      kind: "approval.consumed",
      ts: (inputs.now ?? Date.now)(),
      sessionId: inputs.sessionId,
      proposalId: inputs.proposal.proposalId,
      envelopeDigest: original,
      approverId: this.approvals.get(inputs.approvalId)?.approverId,
      decision: "approve",
      policyId: this.policy.policyId,
    });

    const rec = this.approvals.get(inputs.approvalId);
    return {
      envelope: inputs.proposal,
      envelopeDigest: original,
      riskClass: inputs.proposal.riskClass,
      permitted: true,
      requiresApproval: false,
      approval: rec ?? undefined,
    };
  }

  /**
   * Compute the envelope digest that a fresh proposal would produce from
   * `inputs.live`, sharing the supplied `proposalId` so the bytes are
   * comparable to the proposal digest. This is the TOCTOU anchor: any
   * change in live state (URL, secret version, fingerprint) changes
   * the preconditions list and therefore the digest.
   */
  private computeDigestForLiveState(inputs: GateInputs): string {
    const live = inputs.live;
    const risk = inputs.proposal
      ? inputs.proposal.riskClass
      : classifyRisk(inputs.tool, {
          effectiveUrl: live.effectiveUrl,
          origin: live.origin,
          formAction: inputs.formAction,
          formMethod: inputs.formMethod,
          arguments: inputs.arguments,
        });
    const envelope: ProposedActionEnvelope = {
      version: ENVELOPE_VERSION,
      proposalId: inputs.proposal?.proposalId ?? inputs.proposalId ?? randomUUID(),
      tool: inputs.tool,
      sessionId: inputs.sessionId,
      pageUrl: live.pageUrl,
      frameUrl: live.frameUrl,
      effectiveUrl: live.effectiveUrl,
      origin: live.origin,
      target: inputs.proposal?.target ?? pickTarget(inputs.arguments),
      arguments: inputs.proposal?.arguments ?? redactSecrets(inputs.arguments),
      secrets: (inputs.secrets ?? []).map((s) => ({
        id: s.id,
        version: s.version,
        versionHash: s.versionHash,
      })),
      riskClass: risk,
      workflow: inputs.workflowId ? { id: inputs.workflowId, expectedRisk: risk } : inputs.proposal?.workflow,
      preconditions: [
        {
          kind: "page.url",
          digest: simpleHash(`${live.pageUrl}|${live.frameUrl}`),
          note: `${safeUrlForSummary(live.pageUrl)} @ ${safeUrlForSummary(live.frameUrl)}`,
        },
        ...(live.targetFingerprint ? [{ kind: "target.fingerprint", digest: live.targetFingerprint }] : []),
        ...Object.entries(live.liveSecretVersions).map(([id, version]) => ({
          kind: "secret.version",
          digest: simpleHash(`${id}@${version}`),
          note: id,
        })),
      ],
      proposedAt: inputs.proposal?.proposedAt ?? (inputs.now ?? Date.now)(),
    };
    return digestEnvelope(envelope);
  }

  /** Record the outcome of a permitted dispatch for the audit log. */
  recordDispatch(
    inputs: { sessionId: string; tool: string; envelopeDigest?: string; proposalId?: string },
    outcome: { ok: boolean; reason?: string; context?: Record<string, unknown> },
  ): void {
    this.audit({
      kind: outcome.ok ? "dispatch.completed" : "dispatch.failed",
      ts: Date.now(),
      sessionId: inputs.sessionId,
      tool: inputs.tool,
      envelopeDigest: inputs.envelopeDigest,
      proposalId: inputs.proposalId,
      outcome: outcome.ok ? "ok" : "error",
      reason: outcome.reason,
      policyId: this.policy.policyId,
      context: outcome.context,
    });
  }

  /** Mint a new approval row for an envelope returned by `propose`. */
  mintApproval(input: {
    envelope: ProposedActionEnvelope;
    envelopeDigest: string;
    approverId: string;
    decision: "approve" | "deny";
    summary: string;
    now?: () => number;
  }): ApprovalRecord {
    const rec = this.approvals.mint({
      envelope: input.envelope,
      envelopeDigest: input.envelopeDigest,
      approverId: input.approverId,
      decision: input.decision,
      ttlMs: this.policy.approvalTtlMs,
      policyId: this.policy.policyId,
      summary: input.summary,
      now: input.now,
    });
    this.audit({
      kind: "approval.minted",
      ts: rec.issuedAt,
      sessionId: input.envelope.sessionId,
      proposalId: input.envelope.proposalId,
      envelopeDigest: rec.envelopeDigest,
      approverId: rec.approverId,
      decision: rec.decision,
      policyId: this.policy.policyId,
    });
    return rec;
  }
}

/** Build the EnvelopeTarget from the call-site arguments (best-effort). */
function pickTarget(args: Record<string, unknown>): ProposedActionEnvelope["target"] {
  const ref = typeof args.ref === "string" ? args.ref : undefined;
  const selector = typeof args.selector === "string" ? args.selector : undefined;
  const x = typeof args.x === "number" ? args.x : undefined;
  const y = typeof args.y === "number" ? args.y : undefined;
  const formAction = typeof args.formAction === "string" ? args.formAction : undefined;
  const formMethod = typeof args.formMethod === "string" ? args.formMethod : undefined;

  if (formAction) {
    return { kind: "form", formAction, formMethod };
  }
  if (ref) return { kind: "ref", ref };
  if (selector) return { kind: "selector", selector };
  if (x !== undefined && y !== undefined) return { kind: "coordinate", x, y };
  return { kind: "selector" };
}

/** Strip any obvious secret-looking string from arguments before audit. */
function redactSecrets(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = v;
  }
  return out;
}

function safeUrlForSummary(url: string): string {
  if (!url) return "<none>";
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return "<unparseable>";
  }
}

/** Tiny FNV-1a-ish digest for the audit precondition field. Not cryptographic. */
function simpleHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
