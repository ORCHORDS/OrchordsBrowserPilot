/**
 * Canonical proposed-action envelope for issue #81.
 *
 * Every browser action that touches a policy checkpoint is represented as
 * a deterministic JSON document. Two byte-identical inputs MUST produce
 * byte-identical envelopes; an approval or audit record is meaningless
 * otherwise, because the digest it binds to would not match the call the
 * executor dispatches.
 *
 * Fields are frozen: any future extension is additive and ordered (callers
 * use `canonicalizeEnvelope` below, which sorts object keys), and the
 * `version` field is part of the digest so older approvals stay valid
 * when the format evolves.
 */

export const ENVELOPE_VERSION = 1;

/** Risk classes the gate can assign. Ordered by severity for monotonicity. */
export type RiskClass = "read" | "mutate" | "sensitive" | "irreversible";

/** Policy outcomes. Models may suggest but cannot bypass these. */
export type PolicyOutcome =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "require_approval"; approvalId: string; expiresAt: number }
  | { kind: "require_elevated_scope"; scope: string }
  | { kind: "require_workflow_grant"; workflowId: string };

/**
 * The shape of a stable target identity. `selector` is the literal CSS or
 * role+name selector Playwright would use; `fingerprint` is a hash of the
 * element's live DOM/attributes at proposal time so a later TOCTOU check
 * can detect "different element with the same selector".
 */
export interface EnvelopeTarget {
  kind: "ref" | "selector" | "coordinate" | "form";
  /** Literal selector / ref string / coordinate pair as a stable token. */
  selector?: string;
  ref?: string;
  x?: number;
  y?: number;
  /** Form method/destination when the target is a form submit. */
  formAction?: string;
  formMethod?: string;
  /** Element-role + accessible-name fingerprint for ref resolution. */
  role?: string;
  name?: string;
  /** SHA-256 hex of the element's outerHTML + attribute snapshot at propose time. */
  fingerprint?: string;
}

/** Identifier for a secret reference — never the plaintext. */
export interface SecretReference {
  id: string;
  /** Monotonic version used to detect secret rotation between approval and dispatch. */
  version: number;
  /** SHA-256 hex of the resolved secret at the time the approval was minted. */
  versionHash: string;
}

/**
 * The canonical envelope. Field order in this interface is the documented
 * order, but `canonicalizeEnvelope` is what callers actually pass to the
 * digest — it strips undefined fields and sorts the remaining keys, so the
 * on-the-wire byte sequence is unambiguous regardless of how the call site
 * constructed the object.
 */
export interface ProposedActionEnvelope {
  version: typeof ENVELOPE_VERSION;
  /** Stable id for the envelope (random per proposal). */
  proposalId: string;
  /** Tool name (e.g. `browser_click`) or semantic kind (`semantic_act`). */
  tool: string;
  /** Optional subkind for semantic / workflow actions. */
  actionKind?: string;
  /** Session id and page/frame the action targets. */
  sessionId: string;
  pageUrl: string;
  frameUrl: string;
  /** Effective destination after redirects at proposal time. */
  effectiveUrl: string;
  /** Origin (scheme + host + port) of the effective URL. */
  origin: string;
  /** Target identity — ref / selector / coordinate / form fields. */
  target: EnvelopeTarget;
  /** Normalized, non-secret arguments (e.g. text to type, screenshot path). */
  arguments: Record<string, unknown>;
  /** Secret refs the action consumes — never plaintext. */
  secrets: SecretReference[];
  /** Risk class assigned by the classifier. */
  riskClass: RiskClass;
  /** Caller-supplied workflow / task context, when present. */
  workflow?: { id: string; expectedRisk?: RiskClass };
  /** Material preconditions: anything that must hold for the action to be safe. */
  preconditions: Array<{
    kind: string;
    /** Hash of the material state (e.g. URL + body digest). */
    digest: string;
    /** Free-form context for human-readable summaries — secrets MUST NOT appear here. */
    note?: string;
  }>;
  /** Wall-clock proposal time (ms since epoch). */
  proposedAt: number;
}

/**
 * Stringify an envelope deterministically. The implementation:
 *   - removes undefined entries from objects,
 *   - sorts object keys lexicographically,
 *   - serializes arrays in their declared order (arrays are not sorted),
 *   - uses a stable JSON parser (no BigInt, no Infinity).
 *
 * Two callers that build the same logical envelope must produce identical
 * strings, byte for byte, so the digest is comparable across processes.
 */
export function canonicalizeEnvelope(env: ProposedActionEnvelope): string {
  return JSON.stringify(canonicalizeValue(env));
}

function canonicalizeValue(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Non-finite numbers are not allowed in canonical envelopes");
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalizeValue);
  if (typeof value !== "object") return value;
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src).sort()) {
    const v = src[key];
    if (v === undefined) continue;
    out[key] = canonicalizeValue(v);
  }
  return out;
}

/** Origin string (scheme://host[:port]) — defensively copy for envelope stability. */
export function originFromUrl(url: string): string {
  try {
    const u = new URL(url);
    if (!u.protocol || !u.host) return "";
    return u.port ? `${u.protocol}//${u.host}` : `${u.protocol}//${u.host}`;
  } catch {
    return "";
  }
}
