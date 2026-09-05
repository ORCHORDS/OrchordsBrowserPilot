// Schema migrations (#138).
//
// The extension's persisted state lives in two places:
//
//   * `chrome.storage.local` — pairing credential, settings,
//     site-authorizations, onboarding.
//   * `chrome.storage.session` — replay keys, control state, in-flight
//     envelopes, lifecycle data.
//
// Every persisted blob is versioned by an integer `_schema` field at the
// root. This module is the canonical list of migrations: each entry
// defines a `from` → `to` step, the migration function, and a guard
// that the result remains forward-compatible.
//
// The migrations run inside a `chrome.runtime.onInstalled` upgrade hook
// and are pure functions so they can be unit-tested without a browser.

export const CURRENT_SCHEMA_VERSION = 4;

export const MIGRATIONS = Object.freeze([
  { from: 1, to: 2, migrate: migrateV1ToV2 },
  { from: 2, to: 3, migrate: migrateV2ToV3 },
  { from: 3, to: 4, migrate: migrateV3ToV4 },
]);

function migrateV1ToV2(state) {
  if (!state || typeof state !== "object") return state;
  return { ...state, _schema: 2, settings: { ...(state.settings ?? {}), interfaceDensity: "default" } };
}

function migrateV2ToV3(state) {
  if (!state || typeof state !== "object") return state;
  const settings = { ...(state.settings ?? {}) };
  if (!("diagnosticsOptIn" in settings)) settings.diagnosticsOptIn = false;
  return { ...state, _schema: 3, settings };
}

function migrateV3ToV4(state) {
  if (!state || typeof state !== "object") return state;
  const siteAuthorizations = { ...(state.siteAuthorizations ?? {}) };
  if (!Array.isArray(siteAuthorizations.onceUsed)) siteAuthorizations.onceUsed = [];
  if (!Array.isArray(siteAuthorizations.audit)) siteAuthorizations.audit = [];
  return { ...state, _schema: 4, siteAuthorizations };
}

export function migrationPlan(currentVersion) {
  if (!Number.isInteger(currentVersion) || currentVersion < 1) {
    return { ok: false, code: "invalid_version", from: currentVersion };
  }
  if (currentVersion > CURRENT_SCHEMA_VERSION) {
    return { ok: false, code: "downgrade_unsupported", from: currentVersion, to: CURRENT_SCHEMA_VERSION };
  }
  if (currentVersion === CURRENT_SCHEMA_VERSION) {
    return { ok: true, steps: [], from: currentVersion, to: CURRENT_SCHEMA_VERSION };
  }
  const steps = [];
  let cursor = currentVersion;
  while (cursor < CURRENT_SCHEMA_VERSION) {
    const next = MIGRATIONS.find((m) => m.from === cursor);
    if (!next) return { ok: false, code: "missing_migration", from: cursor };
    steps.push(next);
    cursor = next.to;
  }
  return { ok: true, steps, from: currentVersion, to: cursor };
}

export function runMigrations(state, { now = Date.now } = {}) {
  const version = Number.isInteger(state?._schema) ? state._schema : 1;
  const plan = migrationPlan(version);
  if (!plan.ok) return { ok: false, code: plan.code };
  let cursor = state;
  const applied = [];
  for (const step of plan.steps) {
    const migrated = step.migrate(cursor);
    migrated._migratedAt = now();
    migrated._migrationPath = [...(cursor._migrationPath ?? []), `${step.from}->${step.to}`];
    cursor = migrated;
    applied.push(`${step.from}->${step.to}`);
  }
  return { ok: true, state: cursor, applied };
}

// Compatibility window: a state whose `_schema` is older than the
// supported floor is rolled back to a fresh default after a backup copy
// is captured. The backup is returned so the caller can persist it
// somewhere safe.
export const MIN_SUPPORTED_SCHEMA_VERSION = 1;
export const SUPPORTED_COMPAT_WINDOW_VERSIONS = [1, 2, 3, 4];

export function rollbackIfUnsupported(state, defaults) {
  if (state && typeof state === "object" && Number.isInteger(state._schema)) {
    if (SUPPORTED_COMPAT_WINDOW_VERSIONS.includes(state._schema)) return { ok: true, state };
  }
  return {
    ok: true,
    state: { ...(defaults ?? {}), _schema: CURRENT_SCHEMA_VERSION, _rolledBack: true },
    backup: state ?? null,
  };
}
