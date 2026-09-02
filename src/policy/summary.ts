import type { ProposedActionEnvelope } from "./envelope.js";

/**
 * Build a human-readable summary of a proposed action. Used by the
 * approval UI/API and the audit context. Secrets are NEVER included;
 * only their reference IDs.
 */
export function summarizeEnvelope(env: ProposedActionEnvelope): string {
  const lines: string[] = [];
  lines.push(`Tool: ${env.tool}${env.actionKind ? ` (${env.actionKind})` : ""}`);
  lines.push(`Risk: ${env.riskClass}`);
  lines.push(`Origin: ${env.origin || "<none>"}`);
  if (env.effectiveUrl) lines.push(`Destination: ${env.effectiveUrl}`);
  if (env.target.kind === "ref" && env.target.ref) lines.push(`Target ref: ${env.target.ref}`);
  if (env.target.kind === "selector" && env.target.selector)
    lines.push(`Target selector: ${env.target.selector}`);
  if (env.target.kind === "coordinate" && env.target.x !== undefined && env.target.y !== undefined) {
    lines.push(`Target coordinate: (${env.target.x}, ${env.target.y})`);
  }
  if (env.target.kind === "form") {
    lines.push(`Form: ${env.target.formMethod ?? "GET"} ${env.target.formAction ?? ""}`);
  }
  if (env.secrets.length > 0) {
    lines.push(`Secrets: ${env.secrets.map((s) => `${s.id}@v${s.version}`).join(", ")}`);
  }
  if (env.workflow) lines.push(`Workflow: ${env.workflow.id}`);
  if (env.preconditions.length > 0) {
    lines.push(`Preconditions: ${env.preconditions.map((p) => p.kind).join(", ")}`);
  }
  return lines.join("\n");
}
