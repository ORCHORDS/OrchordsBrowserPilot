import type { RiskClass } from "./envelope.js";

/**
 * Versioned Policy Decision Engine — issue #112.
 *
 * A single ActionGate has to consult five distinct control surfaces and
 * collapse their verdicts into one rule. Naively, that's a tangle of
 * `if (auth) if (egress) if (capability) if (dataflow) if (risk)` checks
 * scattered across the gate. The bug surface is enormous: a new egress
 * rule gets forgotten in one branch, or risk escalation silently
 * downgrades because the wrong branch wins, or two engines (one in
 * semantic workflows, one in primitive dispatch) drift apart.
 *
 * `PolicyDecisionEngine` solves this with a fixed composition:
 *
 *   1. Each control surface produces a verdict (`allow` / `deny` /
 *      `require_approval` / `require_elevated_scope`), a reason, and a
 *      contribution to the human-readable summary.
 *   2. `compose()` reduces N verdicts into one by precedence:
 *        deny > require_elevated_scope > require_approval > allow.
 *      This is intentional: any deny short-circuits; any "needs higher
 *      scope" beats "needs approval" because the approval UI can't grant
 *      a scope the principal doesn't have; any "needs approval" beats a
 *      simple allow.
 *   3. The composed decision carries `policyVersion`. Every verdict from
 *      every control surface is captured in `contributions[]` and tagged
 *      with the version of the engine that produced it. Audit replay
 *      can reconstruct exactly why a 6-month-old decision was made,
 *      even after the engine has been upgraded.
 *   4. The composition is deterministic: same inputs, same version →
 *      same decision. The engine never consults external state besides
 *      the supplied controls — there is no implicit "current time" or
 *      "current network" that could change the verdict silently.
 *
 * The engine does NOT replace the approval store or the audit sink.
 * `ActionGate` already invokes both around this engine; the engine just
 * answers "given these five verdicts, what's the decision?".
 */

export const POLICY_ENGINE_VERSION = 1;

/** What a control surface returns. */
export type VerdictKind = "allow" | "deny" | "require_approval" | "require_elevated_scope";

export interface Verdict {
  kind: VerdictKind;
  /** Stable machine-readable reason token; required when kind != allow. */
  reason?: string;
  /** Free-form human summary line — never includes secret plaintext. */
  note?: string;
  /** Optional elevated-scope id (for `require_elevated_scope`). */
  scope?: string;
}

/** Inputs the controls consult. The engine itself never inspects them. */
export interface PolicyInputs {
  /** The primitive tool name being dispatched (e.g. `browser_click`). */
  tool: string;
  /** Resolved risk class from the risk classifier. */
  risk: RiskClass;
  /** Effective URL the action will land on. */
  effectiveUrl: string;
  /** Origin (scheme://host[:port]) of the effective URL. */
  origin: string;
  /** Secret refs the action consumes — never plaintext. */
  secretIds: string[];
  /** Principal claims / auth context for the caller. */
  principal: {
    id: string;
    scopes: string[];
    /** Data classification labels the principal is allowed to read. */
    dataLabels: string[];
  };
  /** Data-flow labels on the action's outbound payload (e.g. `pii`, `pi`,
   *  `payment`, `credentials`). */
  dataFlowLabels: string[];
  /** Optional workflow id when the action was triggered by a workflow. */
  workflowId?: string;
}

/** Result of the composed decision. */
export interface PolicyDecision {
  /** Engine version that produced this decision. */
  policyVersion: number;
  /** The composed verdict. */
  verdict: Verdict;
  /** Per-control verdicts, in precedence order, for audit replay. */
  contributions: Array<{
    control: PolicyControlKind;
    verdict: Verdict;
    /** Which engine version produced the contribution. */
    policyVersion: number;
  }>;
  /** True iff the action may proceed without escalation. */
  permitted: boolean;
  /** True iff the caller must obtain approval before retrying. */
  requiresApproval: boolean;
  /** True iff the caller must obtain an elevated scope / re-auth first. */
  requiresElevatedScope: boolean;
  /** Human-readable explanation, one control per line. */
  summary: string;
}

export type PolicyControlKind =
  | "auth"
  | "egress"
  | "capability"
  | "dataflow"
  | "risk";

/** A single control surface. Pure function of inputs — no external state. */
export type PolicyControl = {
  kind: PolicyControlKind;
  /** A monotonic, fast check. Returning `deny` short-circuits composition. */
  evaluate: (inputs: PolicyInputs) => Verdict;
};

/**
 * Default controls wired into the engine. The shape of each control is
 * narrow and explicit — a control author MUST read `inputs.principal`
 * and not, say, reach into the wider session object. The gate constructs
 * the engine with these defaults; tests inject simpler controls.
 */
export const defaultControls: PolicyControl[] = [
  {
    kind: "auth",
    evaluate: (i) => {
      if (!i.principal.id) {
        return { kind: "deny", reason: "principal_missing", note: "No authenticated principal on the request." };
      }
      if (i.principal.scopes.length === 0) {
        return { kind: "require_elevated_scope", scope: "browser:basic", reason: "missing_scope_browser_basic" };
      }
      return { kind: "allow", note: `Principal ${i.principal.id} authenticated.` };
    },
  },
  {
    kind: "egress",
    evaluate: (i) => {
      // Defensive: refuse anything not parseable as an http(s) origin.
      let host = "";
      try {
        const u = new URL(i.effectiveUrl);
        if (u.protocol !== "http:" && u.protocol !== "https:") {
          return { kind: "deny", reason: "egress_non_http", note: `Egress scheme ${u.protocol || "<empty>"} denied.` };
        }
        host = u.host;
      } catch {
        return { kind: "deny", reason: "egress_unparseable_url", note: "Destination URL is not parseable." };
      }
      // Loopback + RFC1917 are denied by default unless the principal carries
      // an explicit `egress:internal` scope; this is the inverse of naive
      // browsers which often default to allowing localhost.
      const isInternal =
        host === "localhost" ||
        host === "127.0.0.1" ||
        host === "::1" ||
        host.endsWith(".local") ||
        /^10\./.test(host) ||
        /^192\.168\./.test(host) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host);
      if (isInternal && !i.principal.scopes.includes("egress:internal")) {
        return {
          kind: "require_elevated_scope",
          scope: "egress:internal",
          reason: "egress_internal_requires_scope",
          note: `Destination ${host} is internal network.`,
        };
      }
      return { kind: "allow", note: `Egress to ${host} permitted.` };
    },
  },
  {
    kind: "capability",
    evaluate: (i) => {
      // Irreversible risk requires the explicit `capability:irreversible` scope.
      if (i.risk === "irreversible" && !i.principal.scopes.includes("capability:irreversible")) {
        return {
          kind: "require_elevated_scope",
          scope: "capability:irreversible",
          reason: "capability_irreversible_requires_scope",
          note: "Irreversible actions require explicit capability scope.",
        };
      }
      // Sensitive risk requires `capability:sensitive`.
      if (i.risk === "sensitive" && !i.principal.scopes.includes("capability:sensitive")) {
        return {
          kind: "require_elevated_scope",
          scope: "capability:sensitive",
          reason: "capability_sensitive_requires_scope",
          note: "Sensitive actions require explicit capability scope.",
        };
      }
      return { kind: "allow", note: `Capability check passed for risk=${i.risk}.` };
    },
  },
  {
    kind: "dataflow",
    evaluate: (i) => {
      // Every label on the action must be readable by the principal.
      const forbidden = i.dataFlowLabels.filter((label) => !i.principal.dataLabels.includes(label));
      if (forbidden.length > 0) {
        return {
          kind: "deny",
          reason: "dataflow_label_not_permitted",
          note: `Principal cannot carry labels: ${forbidden.join(", ")}.`,
        };
      }
      // Any secret reference must also be a permitted label.
      const missingSecretLabels = i.secretIds.filter((id) => !i.principal.dataLabels.includes(`secret:${id}`));
      if (missingSecretLabels.length > 0) {
        return {
          kind: "deny",
          reason: "dataflow_secret_label_missing",
          note: `Principal missing secret labels: ${missingSecretLabels.join(", ")}.`,
        };
      }
      return { kind: "allow", note: "Data-flow labels permitted." };
    },
  },
  {
    kind: "risk",
    evaluate: (i) => {
      // The risk control converts risk class into an approval verdict;
      // irreversible always requires approval, sensitive may require it.
      if (i.risk === "irreversible") {
        return { kind: "require_approval", reason: "risk_irreversible", note: "Irreversible risk requires approval." };
      }
      if (i.risk === "sensitive") {
        return { kind: "require_approval", reason: "risk_sensitive", note: "Sensitive risk requires approval." };
      }
      return { kind: "allow", note: `Risk=${i.risk} permitted without approval.` };
    },
  },
];

const VERDICT_PRECEDENCE: Record<VerdictKind, number> = {
  deny: 4,
  require_elevated_scope: 3,
  require_approval: 2,
  allow: 1,
};

function winningVerdict(a: Verdict, b: Verdict): Verdict {
  return VERDICT_PRECEDENCE[a.kind] >= VERDICT_PRECEDENCE[b.kind] ? a : b;
}

/**
 * The decision engine. Construct one per gate; controls are immutable
 * after construction. Composition is pure — no Date.now(), no random
 * sources, no process-wide state — so the result is fully reproducible
 * given the same `PolicyInputs` and engine version.
 */
export class PolicyDecisionEngine {
  readonly policyVersion: number;

  constructor(
    private readonly controls: PolicyControl[] = defaultControls,
    policyVersion: number = POLICY_ENGINE_VERSION,
  ) {
    this.policyVersion = policyVersion;
    const seen = new Set<PolicyControlKind>();
    for (const c of controls) {
      if (seen.has(c.kind)) {
        throw new Error(`PolicyDecisionEngine: duplicate control "${c.kind}"`);
      }
      seen.add(c.kind);
    }
    if (controls.length === 0) {
      throw new Error("PolicyDecisionEngine: at least one control is required");
    }
  }

  /**
   * Compose verdicts into a single decision. The composition order is
   * the order of `this.controls`; a control's verdict replaces the
   * running composite only if it has higher precedence. The final
   * `verdict` is therefore the highest-precedence verdict produced by
   * any control — never a "default allow" inserted by the engine.
   */
  decide(inputs: PolicyInputs): PolicyDecision {
    let composite: Verdict = { kind: "allow", note: "Initial verdict (no control contributed)." };
    const contributions: PolicyDecision["contributions"] = [];
    for (const control of this.controls) {
      const v = control.evaluate(inputs);
      contributions.push({ control: control.kind, verdict: v, policyVersion: this.policyVersion });
      composite = winningVerdict(composite, v);
    }
    return {
      policyVersion: this.policyVersion,
      verdict: composite,
      contributions,
      permitted: composite.kind === "allow",
      requiresApproval: composite.kind === "require_approval",
      requiresElevatedScope: composite.kind === "require_elevated_scope",
      summary: contributions
        .map((c) => `${c.control}: ${c.verdict.kind}${c.verdict.reason ? ` (${c.verdict.reason})` : ""}`)
        .join(" | "),
    };
  }
}

/** Test helper: a control that always returns the supplied verdict. */
export function stubControl(kind: PolicyControlKind, verdict: Verdict): PolicyControl {
  return { kind, evaluate: () => verdict };
}
