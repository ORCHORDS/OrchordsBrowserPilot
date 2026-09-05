// Extension settings store (#129).
//
// Pure data layer for persisted user preferences. The allow-list of keys is
// the source of truth: anything not in this list is dropped on write. No raw
// tokens, no local paths, no native-host secrets are accepted here. The
// settings store is loaded from / saved to chrome.storage.local by the
// service worker; the popup reads snapshots over chrome.runtime.sendMessage.

const STORAGE_KEY = "orchordsExtensionSettings";

const KEY_ALLOWLIST = Object.freeze([
  "startupBehavior",
  "diagnosticsOptIn",
  "coreEndpoint",
  "interfaceDensity",
]);

const STARTUP_BEHAVIORS = Object.freeze(["remember", "idle", "disconnected"]);
const INTERFACE_DENSITIES = Object.freeze(["compact", "default", "verbose"]);

const DEFAULTS = Object.freeze({
  startupBehavior: "remember",
  diagnosticsOptIn: false,
  coreEndpoint: "",
  interfaceDensity: "default",
});

function isString(value) {
  return typeof value === "string";
}

function cleanString(value, maxLen = 256) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLen) return undefined;
  return trimmed;
}

function cleanStartupBehavior(value) {
  const candidate = typeof value === "string" ? value.trim() : "";
  return STARTUP_BEHAVIORS.includes(candidate) ? candidate : undefined;
}

function cleanInterfaceDensity(value) {
  const candidate = typeof value === "string" ? value.trim() : "";
  return INTERFACE_DENSITIES.includes(candidate) ? candidate : undefined;
}

function cleanDiagnosticsOptIn(value) {
  if (typeof value === "boolean") return value;
  return undefined;
}

function cleanCoreEndpoint(value) {
  const candidate = cleanString(value, 256);
  if (!candidate) return "";
  // Only allow http(s) URL; refuse anything else to keep secrets out of the
  // settings store and avoid inadvertent native-host redirection.
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

const CLEANERS = Object.freeze({
  startupBehavior: cleanStartupBehavior,
  diagnosticsOptIn: cleanDiagnosticsOptIn,
  coreEndpoint: cleanCoreEndpoint,
  interfaceDensity: cleanInterfaceDensity,
});

export function defaultSettings() {
  return { ...DEFAULTS };
}

export function cleanSettings(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return defaultSettings();
  const out = defaultSettings();
  for (const key of KEY_ALLOWLIST) {
    if (!Object.prototype.hasOwnProperty.call(CLEANERS, key)) continue;
    const next = CLEANERS[key](input[key]);
    if (next !== undefined) out[key] = next;
  }
  return out;
}

export function snapshotSettings(input) {
  return cleanSettings(input);
}

export async function loadSettings(storageArea) {
  const stored = await storageArea.get(STORAGE_KEY);
  const candidate = stored?.[STORAGE_KEY];
  return cleanSettings(candidate);
}

export async function saveSettings(storageArea, partial) {
  const next = cleanSettings(partial);
  await storageArea.set({ [STORAGE_KEY]: next });
  return next;
}

export const SETTINGS_STORAGE_KEY = STORAGE_KEY;
export const SETTINGS_KEY_ALLOWLIST = KEY_ALLOWLIST;
export const SETTINGS_DEFAULTS = DEFAULTS;

export function assertValidSettingsKey(key) {
  if (!isString(key) || !KEY_ALLOWLIST.includes(key)) {
    throw new Error(`unknown settings key: ${String(key)}`);
  }
}
