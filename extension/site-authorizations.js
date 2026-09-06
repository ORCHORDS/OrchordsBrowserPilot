// Per-site / per-origin extension authorization registry (#124).
//
// The extension MUST NOT gain blanket authority over every website merely
// because it is installed. Every active-tab interaction goes through this
// module to compute the effective site authorization for an origin and to
// record every grant / revocation. Grants can be issued by the user
// (`allow_once`, `allow_for_session`, `allow_for_site`, `revoke_site`, `deny_site`)
// and can never be issued by page content.
//
// Storage is shape-compatible with chrome.storage.local (plain JSON).
// The registry is the single source of truth for:
//   - The set of origins explicitly granted by the user.
//   - The set of origins explicitly denied by the user (deny-list).
//   - The audit log of grant / revocation / decision events.
//
// Origin canonicalisation (per #124 acceptance criteria):
//   - Scheme is lower-cased.
//   - Host is lower-cased (IDN punycode is expected upstream).
//   - Default ports are stripped.
//   - No userinfo, fragment, or path is kept.
//
// A grant is keyed by origin and carries the kind:
//   - "site"    — persistent user grant for the origin.
//   - "session" — transient legacy/session grant; never durable.
//   - "once"    — applies only to the next single dispatch.
export const GRANT_KIND = Object.freeze({
  ONCE: "once",
  SESSION: "session",
  SITE: "site",
});

const STORAGE_KEY = "orchordsSiteAuthorizations";

function canonicalizeOrigin(value) {
  if (typeof value !== "string") return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname) return null;
  return `${url.protocol}//${url.hostname.toLowerCase()}`;
}

function isOrigin(value) {
  return typeof value === "string" && /^https?:\/\/[a-z0-9.\-]+(?::\d+)?$/.test(value);
}

function clampAudit(log, limit) {
  if (!Array.isArray(log)) return [];
  if (log.length <= limit) return log.slice();
  return log.slice(log.length - limit);
}

function defaultNow() {
  return Date.now();
}

const DEFAULT_AUDIT_LIMIT = 256;

export function createSiteAuthorizations(options = {}) {
  const now = options.now ?? defaultNow;
  const limit = Number.isInteger(options.auditLimit) && options.auditLimit > 0
    ? options.auditLimit
    : DEFAULT_AUDIT_LIMIT;
  const grants = new Map();
  const denials = new Map();
  const onceUsed = new Set();
  const audit = clampAudit(options.audit ?? [], limit);

  for (const entry of options.grants ?? []) {
    if (
      entry &&
      isOrigin(entry.origin) &&
      (entry.kind === GRANT_KIND.SITE || entry.kind === GRANT_KIND.SESSION || entry.kind === GRANT_KIND.ONCE)
    ) {
      grants.set(entry.origin, { kind: entry.kind, grantedAt: Number(entry.grantedAt) || now() });
    }
  }
  for (const origin of options.denials ?? []) {
    if (isOrigin(origin)) denials.set(origin, { deniedAt: now() });
  }
  for (const origin of options.onceUsed ?? []) {
    if (isOrigin(origin)) onceUsed.add(origin);
  }

  function record(entry) {
    audit.push({ at: now(), ...entry });
    if (audit.length > limit) audit.splice(0, audit.length - limit);
  }

  function originOf(urlLike) {
    return canonicalizeOrigin(urlLike);
  }

  function listGranted() {
    return Array.from(grants.entries()).map(([origin, value]) => ({ origin, ...value }));
  }

  function listDenied() {
    return Array.from(denials.keys());
  }

  function getAudit() {
    return audit.slice();
  }

  function decisionFor(urlLike, intent = "act") {
    const origin = originOf(urlLike);
    if (!origin) {
      return { kind: "denied", origin: null, reason: "origin not parseable", intent };
    }
    if (denials.has(origin)) {
      return { kind: "denied", origin, reason: "origin explicitly denied", intent };
    }
    const grant = grants.get(origin);
    if (!grant) {
      return { kind: "unknown", origin, reason: "no user grant for origin", intent };
    }
    if (grant.kind === GRANT_KIND.ONCE) {
      if (onceUsed.has(origin)) {
        return { kind: "denied", origin, reason: "once grant already consumed", intent };
      }
      return { kind: "allowed", origin, reason: "once grant pending", intent, grantKind: grant.kind };
    }
    return {
      kind: "allowed",
      origin,
      reason: grant.kind === GRANT_KIND.SITE ? "site grant" : "session grant",
      intent,
      grantKind: grant.kind,
    };
  }

  function grant(origin, kind) {
    const normalized = originOf(origin);
    if (!normalized) throw new Error("site-authorization grant requires a valid http(s) origin");
    if (kind !== GRANT_KIND.SITE && kind !== GRANT_KIND.SESSION && kind !== GRANT_KIND.ONCE) {
      throw new Error(
        `site-authorization grant kind must be one of ${GRANT_KIND.SITE}|${GRANT_KIND.SESSION}|${GRANT_KIND.ONCE}`,
      );
    }
    // Granting an origin implicitly lifts any prior deny, and resets any
    // already-consumed "once" token. This is the user's explicit override.
    denials.delete(normalized);
    onceUsed.delete(normalized);
    grants.set(normalized, { kind, grantedAt: now() });
    record({ kind: "grant", origin: normalized, grantKind: kind });
    return true;
  }

  function revoke(origin, reason = "user revoked") {
    const normalized = originOf(origin);
    if (!normalized) throw new Error("site-authorization revoke requires a valid http(s) origin");
    const hadGrant = grants.delete(normalized);
    const hadDenial = denials.delete(normalized);
    onceUsed.delete(normalized);
    if (hadGrant || hadDenial) {
      record({ kind: "revoke", origin: normalized, reason });
    }
    return hadGrant || hadDenial;
  }

  function deny(origin, reason = "user denied") {
    const normalized = originOf(origin);
    if (!normalized) throw new Error("site-authorization deny requires a valid http(s) origin");
    // Deny implies removing any prior grant; a future allow must be explicit.
    grants.delete(normalized);
    onceUsed.delete(normalized);
    denials.set(normalized, { deniedAt: now() });
    record({ kind: "deny", origin: normalized, reason });
    return true;
  }

  function recordAudit(entry) {
    if (!entry || typeof entry !== "object") return false;
    // Only a known-prefix set of entry kinds may be appended from outside the
    // registry — protects the audit log from arbitrary caller data.
    const allowed = new Set([
      "dispatch.allowed",
      "dispatch.denied",
      "dispatch.unknown_origin",
      "dispatch.drifted_origin",
      "dispatch.consumed_once",
      "dispatch.once_race_lost",
    ]);
    if (!allowed.has(entry.kind)) return false;
    record({ ...entry });
    return true;
  }

  function consumeOnce(urlLike) {
    const origin = originOf(urlLike);
    if (!origin) return false;
    const grant = grants.get(origin);
    if (!grant || grant.kind !== GRANT_KIND.ONCE) return false;
    if (onceUsed.has(origin)) return false;
    onceUsed.add(origin);
    record({ kind: "consume-once", origin });
    return true;
  }

  function snapshot() {
    return {
      grants: listGranted(),
      denials: listDenied(),
      onceUsed: Array.from(onceUsed),
      audit: audit.slice(),
    };
  }

  function durableSnapshot() {
    return {
      grants: listGranted().filter((entry) => entry.kind !== GRANT_KIND.SESSION),
      denials: listDenied(),
      onceUsed: Array.from(onceUsed),
      audit: audit.slice(),
    };
  }

  function exportJson() {
    return JSON.stringify(snapshot());
  }

  return {
    decisionFor,
    grant,
    revoke,
    deny,
    consumeOnce,
    listGranted,
    listDenied,
    getAudit,
    recordAudit,
    snapshot,
    durableSnapshot,
    exportJson,
  };
}

export const STORAGE_KEY_EXPORT = STORAGE_KEY;
