import type { RiskClass } from "./envelope.js";

/**
 * Static tool-level risk assignment. The matrix lives here so adding a new
 * primitive tool requires exactly one entry — there is no hidden heuristic
 * elsewhere. Higher classes override lower classes when combined with other
 * signals (origin, arguments, etc.).
 *
 * The classifier returns the maximum risk across:
 *   - the tool's static class,
 *   - origin / scheme signals (private networks, file://, etc.),
 *   - arg-level heuristics (numeric amounts, file paths, etc.),
 *   - target-form signals (POST + non-loopback host = sensitive).
 *
 * Monotonicity is enforced by `combineRisk` — risk may only go up, never
 * down, when later stages re-evaluate. The gate compares the recorded
 * (proposal-time) risk against the dispatch-time risk and rejects any
 * dispatch whose risk is lower than the recorded one without a fresh
 * policy decision.
 */
export const TOOL_RISK: Record<string, RiskClass> = {
  // read-only
  browser_snapshot: "read",
  browser_console: "read",
  browser_network: "read",
  browser_wait: "read",
  // observable side effects, reversible
  browser_navigate: "mutate",
  browser_click: "mutate",
  browser_type: "mutate",
  browser_fill: "mutate",
  browser_press: "mutate",
  browser_hover: "mutate",
  browser_drag: "mutate",
  browser_select: "mutate",
  browser_screenshot: "mutate",
  browser_evaluate: "sensitive",
  // outbound side effects, often irreversible
  browser_captcha_solve: "sensitive",
};

/** Inputs to the classifier beyond the tool name. */
export interface RiskSignals {
  effectiveUrl: string;
  origin: string;
  formAction?: string;
  formMethod?: string;
  arguments: Record<string, unknown>;
}

/**
 * Classify a proposed action. The output is the highest-severity class
 * that applies. `signals` is best-effort: callers that don't have a form
 * action or origin can pass empty strings and the classifier will simply
 * skip those signals.
 */
export function classifyRisk(tool: string, signals: RiskSignals): RiskClass {
  const toolClass = TOOL_RISK[tool] ?? "sensitive";
  let cur: RiskClass = toolClass;

  cur = combineRisk(cur, classifyOrigin(signals.origin, signals.effectiveUrl));
  cur = combineRisk(cur, classifyForm(signals.formAction, signals.formMethod));
  cur = combineRisk(cur, classifyArguments(signals.arguments));

  return cur;
}

export function combineRisk(a: RiskClass, b: RiskClass): RiskClass {
  return rank(a) >= rank(b) ? a : b;
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

const PRIVATE_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0", "::"]);

function classifyOrigin(origin: string, effectiveUrl: string): RiskClass {
  if (!origin && !effectiveUrl) return "read";
  let host = "";
  let protocol = "";
  try {
    const u = new URL(origin || effectiveUrl);
    host = u.hostname.toLowerCase();
    protocol = u.protocol.toLowerCase();
  } catch {
    return "sensitive";
  }
  if (protocol === "file:") return "irreversible";
  if (protocol === "javascript:") return "irreversible";
  if (protocol === "data:") return "irreversible";
  // Loopback / private RFC1918 / link-local — code on the agent's host.
  if (PRIVATE_HOSTS.has(host)) return "sensitive";
  if (isRfc1918(host) || isLinkLocal(host) || isUniqueLocalV6(host)) return "sensitive";
  return "read";
}

function classifyForm(action: string | undefined, method: string | undefined): RiskClass {
  if (!action) return "read";
  const m = (method ?? "GET").toUpperCase();
  // POST/PUT/PATCH/DELETE to a non-loopback origin is sensitive; to a
  // loopback host it stays at mutate (the user is interacting with their
  // own dev server).
  if (m === "GET" || m === "HEAD") return "read";
  let host = "";
  try {
    host = new URL(action).hostname.toLowerCase();
  } catch {
    return "sensitive";
  }
  if (PRIVATE_HOSTS.has(host)) return "mutate";
  if (isRfc1918(host) || isLinkLocal(host)) return "sensitive";
  return "sensitive";
}

const MONETARY_HINT =
  /(^|[^a-z])(amount|price|total|total_amount|grand_total|charge|cost|fee|qty|quantity|count|balance|usd|eur|gbp|cny|jpy|inr|brl|aud|cad)(\b|[^a-z])/i;
const FILE_PATH_HINT = /(^|[\\/])(([a-z]:[\\/])|(\.\.[\\/])|(~[\\/])|(\/etc\/)|(\/proc\/)|(\/sys\/))/i;
const SECRET_HINT = /(password|passwd|pwd|secret|token|api[_-]?key|auth)/i;

function classifyArguments(args: Record<string, unknown>): RiskClass {
  let cur: RiskClass = "read";
  for (const [key, value] of Object.entries(args)) {
    if (MONETARY_HINT.test(key)) {
      cur = combineRisk(cur, "irreversible");
      continue;
    }
    if (SECRET_HINT.test(key)) {
      cur = combineRisk(cur, "sensitive");
      continue;
    }
    if (FILE_PATH_HINT.test(key)) {
      cur = combineRisk(cur, "sensitive");
      continue;
    }
    if (typeof value === "string") {
      if (MONETARY_HINT.test(value)) cur = combineRisk(cur, "irreversible");
      else if (SECRET_HINT.test(value)) cur = combineRisk(cur, "sensitive");
      else if (FILE_PATH_HINT.test(value)) cur = combineRisk(cur, "sensitive");
    }
  }
  return cur;
}

function isRfc1918(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  if (!parts.every((p) => /^\d+$/.test(p))) return false;
  const [a, b] = [Number(parts[0]), Number(parts[1])];
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function isLinkLocal(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d+$/.test(p)) && parts[0] === "169" && parts[1] === "254";
}

function isUniqueLocalV6(host: string): boolean {
  const h = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return h.toLowerCase().startsWith("fc") || h.toLowerCase().startsWith("fd");
}
