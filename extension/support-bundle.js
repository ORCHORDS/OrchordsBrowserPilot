// Redacted support bundle (#141).
//
// When the user opts in (settings.diagnosticsOptIn), the extension can
// produce a "support bundle" — a JSON blob containing diagnostics,
// audit log, doctor output, and bridge metadata — that the user can
// attach to a support ticket. The bundle MUST be redacted:
//   - the pairing secret is stripped,
//   - the installId is shortened to a fingerprint,
//   - the audit log only carries `from`, `to`, `actor`, `reason` and a
//     coarse timestamp (no envelope ids, no native-host error strings),
//   - local file paths, cookies, and headers never appear,
//   - the envelope history is omitted.

export const SUPPORT_BUNDLE_VERSION = 1;

const REDACTED = "[REDACTED]";

function fingerprint(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  let h = 0;
  for (let i = 0; i < value.length; i += 1) {
    h = (h * 31 + value.charCodeAt(i)) >>> 0;
  }
  return `fp-${h.toString(16).padStart(8, "0")}`;
}

function redactAudit(audit) {
  if (!Array.isArray(audit)) return [];
  return audit.slice(-50).map((entry) => ({
    from: typeof entry.from === "string" ? entry.from : "—",
    to: typeof entry.to === "string" ? entry.to : "—",
    actor: typeof entry.actor === "string" ? entry.actor : "system",
    reason: typeof entry.reason === "string" ? entry.reason : null,
    at: Number.isFinite(entry.at) ? Math.trunc(entry.at / 60_000) * 60_000 : null,
  }));
}

function redactPairing(pairing) {
  if (!pairing || typeof pairing !== "object") return null;
  return {
    pairingId: typeof pairing.pairingId === "string" ? REDACTED : null,
    generation: Number.isInteger(pairing.generation) ? pairing.generation : null,
    fingerprint: typeof pairing.pairingId === "string" ? fingerprint(pairing.pairingId) : null,
  };
}

function redactSiteAuthorizations(authz) {
  if (!authz || typeof authz !== "object") return null;
  const grants = Array.isArray(authz.grants) ? authz.grants.slice(0, 50).map((g) => ({
    origin: typeof g?.origin === "string" ? g.origin : REDACTED,
    kind: typeof g?.kind === "string" ? g.kind : null,
  })) : [];
  return {
    grants,
    denials: Array.isArray(authz.denials) ? authz.denials.slice(0, 50) : [],
    onceUsedCount: Array.isArray(authz.onceUsed) ? authz.onceUsed.length : 0,
    audit: redactAudit(authz.audit),
  };
}

function looksLikePath(value) {
  return typeof value === "string" && (/^[a-z]:\\/i.test(value) || value.includes("/Users/") || value.includes("/home/") || value.includes("/var/") || value.startsWith("/") || value.startsWith("\\"));
}

function redactDoctor(doctor) {
  if (!doctor || typeof doctor !== "object") return null;
  return {
    severity: typeof doctor.severity === "string" ? doctor.severity : "ok",
    issues: Array.isArray(doctor.issues)
      ? doctor.issues.map((issue) => ({
          code: typeof issue?.code === "string" ? (looksLikePath(issue.code) ? "[REDACTED]" : issue.code) : "unknown",
          severity: typeof issue?.severity === "string" ? issue.severity : "info",
          message: typeof issue?.message === "string" ? (looksLikePath(issue.message) ? "[REDACTED]" : issue.message.slice(0, 240)) : "",
          fix: typeof issue?.fix === "string" ? (looksLikePath(issue.fix) ? "[REDACTED]" : issue.fix.slice(0, 240)) : "",
        }))
      : [],
  };
}

export function createSupportBundle(snapshot, { now = Date.now } = {}) {
  if (!snapshot || typeof snapshot !== "object") {
    throw new Error("createSupportBundle requires a snapshot object");
  }
  return {
    version: SUPPORT_BUNDLE_VERSION,
    generatedAt: now(),
    product: "Orchords Web Pilot",
    controlState: {
      state: typeof snapshot.state === "string" ? snapshot.state : "unknown",
      monotonic: Number.isInteger(snapshot.monotonic) ? snapshot.monotonic : 0,
    },
    bridgeCompat: snapshot.bridgeCompat ?? null,
    browser: snapshot.browser ? {
      vendor: typeof snapshot.browser.vendor === "string" ? snapshot.browser.vendor : null,
      version: typeof snapshot.browser.version === "string" ? snapshot.browser.version : null,
    } : null,
    core: snapshot.core ? {
      version: typeof snapshot.core.version === "string" ? snapshot.core.version : null,
    } : null,
    pairing: redactPairing(snapshot.pairing),
    siteAuthorizations: redactSiteAuthorizations(snapshot.siteAuthorizations),
    settings: snapshot.settings && typeof snapshot.settings === "object"
      ? {
          interfaceDensity: snapshot.settings.interfaceDensity ?? null,
          startupBehavior: snapshot.settings.startupBehavior ?? null,
          diagnosticsOptIn: Boolean(snapshot.settings.diagnosticsOptIn),
        }
      : null,
    doctor: redactDoctor(snapshot.doctor),
    lastBridgeError: snapshot.lastBridgeError ? {
      code: typeof snapshot.lastBridgeError.code === "string"
        ? (looksLikePath(snapshot.lastBridgeError.code) ? "[REDACTED]" : snapshot.lastBridgeError.code)
        : null,
      at: Number.isFinite(snapshot.lastBridgeError.at) ? snapshot.lastBridgeError.at : null,
    } : null,
    audit: redactAudit(snapshot.audit),
    notes: [
      "Pairing credential and any local path are intentionally omitted.",
      "Audit entries are coarse-grained to the nearest minute.",
      "Site grants carry only origin + kind, never headers or credential headers.",
    ],
  };
}

export function assertSupportBundleRedactions(bundle) {
  // The forbidden tokens are *value* patterns we never want in the
  // serialised bundle. We scan only the **values** of the bundle to
  // avoid false positives on field names (e.g. "siteAuthorizations"
  // contains "Authorization").
  const forbidden = ["installId", "C:\\", "/Users/", "/home/", "/var/", "cookie", "Authorization", "secret"];
  const text = JSON.stringify(valuesOnly(bundle));
  for (const token of forbidden) {
    if (text.includes(token)) {
      throw new Error(`support bundle leaks forbidden token ${token}`);
    }
  }
  return { ok: true };
}

function valuesOnly(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(valuesOnly);
  if (typeof value === "object") {
    const out = {};
    for (const v of Object.values(value)) out[`_${Math.random().toString(36).slice(2)}`] = valuesOnly(v);
    return out;
  }
  return value;
}
