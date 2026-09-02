/**
 * Append-only audit hook for issue #81 (companion to issue #52).
 *
 * The audit log is intentionally minimal in v1: a structured event per
 * policy decision and dispatch. The shape is what #52 will eventually
 * forward to OpenTelemetry / structured log sinks — the gate writes the
 * full event; downstream sinks can stream the same shape without a
 * translation layer. We never include plaintext secrets in any field.
 */
export type AuditKind =
  | "proposal.created"
  | "proposal.classified"
  | "approval.minted"
  | "approval.consumed"
  | "approval.rejected"
  | "dispatch.completed"
  | "dispatch.failed"
  | "policy.elevated_scope_required"
  | "policy.workflow_grant_required";

export interface AuditEvent {
  kind: AuditKind;
  ts: number;
  sessionId: string;
  proposalId?: string;
  tool?: string;
  envelopeDigest?: string;
  approverId?: string;
  decision?: "approve" | "deny";
  policyId?: string;
  outcome?: "ok" | "denied" | "error";
  reason?: string;
  riskClass?: string;
  /** Free-form context; consumers MUST scrub secret plaintext before logging. */
  context?: Record<string, unknown>;
}

export type AuditSink = (event: AuditEvent) => void;

/** Default sink: noop. Real deployments wire this to OpenTelemetry / a log file. */
export const noopSink: AuditSink = () => undefined;

/** In-memory ring buffer for tests. */
export class MemoryAuditSink {
  private readonly buf: AuditEvent[] = [];
  constructor(private readonly cap = 1000) {}
  emit(event: AuditEvent): void {
    this.buf.push(event);
    if (this.buf.length > this.cap) this.buf.shift();
  }
  /** AuditSink adapter — exposes the same instance as a callable sink. */
  asSink(): AuditSink {
    return (event: AuditEvent) => this.emit(event);
  }
  events(): readonly AuditEvent[] {
    return this.buf;
  }
  clear(): void {
    this.buf.length = 0;
  }
}

/**
 * Compose multiple sinks. Failures in one sink must not stop the others
 * from receiving the event — the audit log is best-effort but consistent.
 */
export function composeSinks(sinks: AuditSink[]): AuditSink {
  return (event) => {
    for (const sink of sinks) {
      try {
        sink(event);
      } catch {
        // intentionally swallow: audit must never block dispatch.
      }
    }
  };
}
