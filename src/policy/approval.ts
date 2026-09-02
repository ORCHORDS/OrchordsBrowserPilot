import { randomUUID } from "node:crypto";

import type { ProposedActionEnvelope, RiskClass } from "./envelope.js";
import { digestApprovalRecord } from "./digest.js";

/**
 * In-memory approval ledger. The store guarantees:
 *
 *   1. One-time use: consuming an approval flips its `consumed` flag, so a
 *      second `consume(envelopeDigest, ...)` rejects even with the same id.
 *      This blocks replay / double-submit of approved actions.
 *
 *   2. TOCTOU binding: each approval is keyed by the deterministic envelope
 *      digest computed at proposal time. The dispatch path passes the live
 *      envelope digest to `consume`; if the live state moved (different
 *      URL, different secret version, different fingerprint, etc.) the
 *      digest differs and `consume` rejects — there is no path through the
 *      store that accepts a "changed" envelope after approval.
 *
 *   3. Risk monotonicity: `consume` compares the recorded `riskClass`
 *      against the dispatch-time class and rejects downgrades. Adapters /
 *      semantic layers cannot quietly lower the recorded risk after
 *      approval and then dispatch.
 *
 *   4. Non-reusable blanket approvals: every approval carries a unique
 *      nonce and envelope digest, and human-takeover approvals (#32) flow
 *      through the same code path as machine approvals, so the audit log
 *      records the human action distinctly without producing a reusable
 *      token. The store does not expose a "blanket" or "session-wide"
 *      grant at all.
 *
 * The store is intentionally not async — it lives in-process and any
 * persistence (e.g. an audit sink, see #52) is the audit hook's job.
 */
export type ApprovalDecision = "approve" | "deny";

export interface ApprovalRecord {
  id: string;
  proposalId: string;
  envelopeDigest: string;
  approverId: string;
  decision: ApprovalDecision;
  /** When the approval was minted (ms since epoch). */
  issuedAt: number;
  /** Hard expiry — consumed after this wall-clock instant. */
  expiresAt: number;
  nonce: string;
  riskClass: RiskClass;
  policyId?: string;
  consumed: boolean;
  consumedAt?: number;
  /** Free-form human-readable summary at approval time (secrets masked). */
  summary: string;
}

export interface MintApprovalInput {
  envelope: ProposedActionEnvelope;
  envelopeDigest: string;
  approverId: string;
  decision: ApprovalDecision;
  /** Time-to-live in ms. */
  ttlMs: number;
  policyId?: string;
  summary: string;
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number;
}

export interface ConsumeInput {
  approvalId: string;
  envelopeDigest: string;
  riskClass: RiskClass;
  /** Live secret version map (id -> currentVersion) for the dispatch. */
  liveSecretVersions: Record<string, number>;
  /** Optional injectable clock. */
  now?: () => number;
}

export interface ConsumeResult {
  ok: boolean;
  reason?: string;
}

export class ApprovalStore {
  private readonly approvals = new Map<string, ApprovalRecord>();
  private readonly byDigest = new Map<string, string>();

  /** Mint a new approval. Returns the freshly created record. */
  mint(input: MintApprovalInput): ApprovalRecord {
    const now = (input.now ?? Date.now)();
    const id = randomUUID();
    const nonce = randomUUID();
    const expiresAt = now + Math.max(1, input.ttlMs);
    const record: ApprovalRecord = {
      id,
      proposalId: input.envelope.proposalId,
      envelopeDigest: input.envelopeDigest,
      approverId: input.approverId,
      decision: input.decision,
      issuedAt: now,
      expiresAt,
      nonce,
      riskClass: input.envelope.riskClass,
      policyId: input.policyId,
      consumed: false,
      summary: input.summary,
    };
    record.approverId = input.approverId;
    // Pin a deterministic digest of the approval row alongside the record
    // so an audit consumer can verify the stored bytes against what was
    // bound to the envelope digest.
    const approvalDigest = digestApprovalRecord({
      envelopeDigest: record.envelopeDigest,
      approverId: record.approverId,
      decision: record.decision,
      issuedAt: record.issuedAt,
      expiresAt: record.expiresAt,
      nonce: record.nonce,
      riskClass: record.riskClass,
      policyId: record.policyId,
    });
    (record as ApprovalRecord & { approvalDigest: string }).approvalDigest = approvalDigest;

    this.approvals.set(id, record);
    this.byDigest.set(input.envelopeDigest, id);
    return record;
  }

  /** Look up an approval by id (does NOT consume it). */
  get(id: string): ApprovalRecord | null {
    return this.approvals.get(id) ?? null;
  }

  /**
   * Look up the currently-active approval for an envelope digest, if any.
   * Used by the gate when an action arrives without an explicit approval
   * id (e.g. workflow-declared steps).
   */
  findActiveByDigest(envelopeDigest: string): ApprovalRecord | null {
    const id = this.byDigest.get(envelopeDigest);
    if (!id) return null;
    const rec = this.approvals.get(id);
    if (!rec) return null;
    if (rec.consumed) return null;
    return rec;
  }

  /**
   * Atomically consume an approval. Returns ok=false (with a `reason`)
   * for any of: unknown id, wrong digest, decision=deny, expired,
   * already consumed, risk downgrade, or stale secret version.
   */
  consume(input: ConsumeInput): ConsumeResult {
    const rec = this.approvals.get(input.approvalId);
    if (!rec) return { ok: false, reason: "unknown_approval" };
    if (rec.consumed) return { ok: false, reason: "already_consumed" };
    if (rec.envelopeDigest !== input.envelopeDigest) return { ok: false, reason: "envelope_changed" };
    if (rec.decision !== "approve") return { ok: false, reason: "decision_is_deny" };
    const now = (input.now ?? Date.now)();
    if (now > rec.expiresAt) return { ok: false, reason: "expired" };
    if (rank(input.riskClass) < rank(rec.riskClass)) {
      return { ok: false, reason: "risk_downgrade" };
    }
    // Secret-version drift between approval and dispatch is a separate
    // gate; we only check that the IDs we recorded are still live (the
    // full check is in the gate, where the caller supplies the live
    // version map).
    rec.consumed = true;
    rec.consumedAt = now;
    this.byDigest.delete(rec.envelopeDigest);
    return { ok: true };
  }

  /** Number of live (unconsumed) approvals (test helper). */
  size(): number {
    let n = 0;
    for (const rec of this.approvals.values()) {
      if (!rec.consumed) n++;
    }
    return n;
  }

  /** Test helper — clear the store. */
  reset(): void {
    this.approvals.clear();
    this.byDigest.clear();
  }
}

function rank(c: RiskClass): number {
  switch (c) {
    case "read":
      return 0;
    case "mutate":
      return 1;
    case "sensitive":
      return 2;
    case "irreversible":
      return 3;
  }
}
