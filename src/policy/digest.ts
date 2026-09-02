import { createHash } from "node:crypto";
import type { ProposedActionEnvelope } from "./envelope.js";
import { canonicalizeEnvelope, ENVELOPE_VERSION } from "./envelope.js";

/**
 * The tag prefixes the SHA-256 inputs with a fixed domain separator so a
 * raw envelope digest can never collide with a digest of any other
 * project artifact (file content, audit row, etc.). 8 bytes of ASCII is
 * plenty for collision resistance and keeps the prefix self-documenting.
 */
const DIGEST_TAG_ENVELOPE = "wp-env1";
const DIGEST_TAG_APPROVAL = "wp-app1";
const DIGEST_TAG_FINGERPRINT = "wp-fp01";

/** Hex SHA-256 over the canonical envelope bytes. */
export function digestEnvelope(env: ProposedActionEnvelope): string {
  // Strip any caller-supplied version so a future bump fails closed: the
  // digest is always computed with the current ENVELOPE_VERSION constant.
  const stripped: ProposedActionEnvelope = { ...env, version: ENVELOPE_VERSION };
  return sha256Hex(DIGEST_TAG_ENVELOPE, canonicalizeEnvelope(stripped));
}

/** Hex SHA-256 over approval-record fields. Tag is different from the envelope. */
export function digestApprovalRecord(record: ApprovalRecordInput): string {
  const sorted = JSON.stringify(record, replacerSort, 0);
  return sha256Hex(DIGEST_TAG_APPROVAL, sorted);
}

/**
 * Element fingerprint: SHA-256 over outerHTML + a sorted attribute map.
 * Lives at a separate tag so we can rotate the fingerprint format without
 * invalidating envelope digests.
 */
export function fingerprintElement(outerHtml: string, attrs: Record<string, string | undefined>): string {
  const sortedAttrs = Object.keys(attrs)
    .sort()
    .map((k) => `${k}=${attrs[k] ?? ""}`)
    .join("\n");
  return sha256Hex(DIGEST_TAG_FINGERPRINT, `${outerHtml}\u0000${sortedAttrs}`);
}

function sha256Hex(tag: string, payload: string): string {
  return createHash("sha256").update(tag).update("\u0000").update(payload).digest("hex");
}

function replacerSort(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) {
      const v = src[k];
      if (v === undefined) continue;
      out[k] = v;
    }
    return out;
  }
  return value;
}

/** Fields bound into the approval digest (separate from the envelope digest). */
export interface ApprovalRecordInput {
  envelopeDigest: string;
  approverId: string;
  decision: "approve" | "deny";
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  riskClass: ProposedActionEnvelope["riskClass"];
  /** Optional policy/role under which the approval was granted. */
  policyId?: string;
}
