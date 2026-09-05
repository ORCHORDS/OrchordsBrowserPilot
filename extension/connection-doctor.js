// Extension connection doctor (#129).
//
// Pure diagnostic: given the current extension state (version, installId,
// pairing, last bridge error, host manifest, browser info), produce a
// categorised checklist of issues the user can act on. The doctor MUST
// NEVER include local paths, raw pairing secrets, or other private values
// in the messages it returns; it returns severity + code + fix instructions.
//
// The doctor runs both on demand (popup button) and reactively when the
// service worker detects a transition to the `error` state.

const SUPPORTED_BROWSERS = ["chrome", "edge"];
const SUPPORTED_MV = 3;
const SUPPORTED_CORE_VERSION_RANGE = { min: "0.1.0", max: "0.1.x" };

function isBrowserInfo(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof value.name === "string" &&
      typeof value.majorVersion === "number",
  );
}

function isCoreInfo(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof value.version === "string",
  );
}

function severityRank(severity) {
  switch (severity) {
    case "blocking":
      return 4;
    case "error":
      return 3;
    case "warning":
      return 2;
    case "info":
      return 1;
    default:
      return 0;
  }
}

function compareVersion(a, b) {
  // Normalise "x" wildcards in either operand to +Infinity so that "0.1.x"
  // is treated as the upper bound of any 0.1.* release.
  const norm = (v) => String(v).split(".").map((part) => {
    if (part === "x" || part === "*") return Number.POSITIVE_INFINITY;
    const n = Number.parseInt(part, 10);
    return Number.isNaN(n) ? 0 : n;
  });
  const ap = norm(a);
  const bp = norm(b);
  const len = Math.max(ap.length, bp.length);
  for (let i = 0; i < len; i++) {
    const ai = ap[i] ?? 0;
    const bi = bp[i] ?? 0;
    if (ai > bi) return 1;
    if (ai < bi) return -1;
  }
  return 0;
}

/**
 * @param {{
 *   manifestVersion?: number,
 *   browser?: unknown,
 *   core?: unknown,
 *   pairing?: unknown,
 *   lastError?: { code?: string, message?: string } | null,
 *   controlState?: string,
 * }} input
 */
export function diagnose(input = {}) {
  const issues = [];

  if (input.manifestVersion !== SUPPORTED_MV) {
    issues.push({
      code: "EXT-MANIFEST-INCOMPATIBLE",
      severity: "blocking",
      message: "Extension manifest is not Manifest V3.",
      fix: "Reinstall the extension from the official store.",
    });
  }

  const browser = isBrowserInfo(input.browser) ? input.browser : null;
  if (!browser) {
    issues.push({
      code: "EXT-BROWSER-UNKNOWN",
      severity: "warning",
      message: "Browser identity could not be determined.",
      fix: "Open the extension options and confirm you are on Chrome 120+ or Edge 120+.",
    });
  } else {
    if (!SUPPORTED_BROWSERS.includes(browser.name.toLowerCase())) {
      issues.push({
        code: "EXT-BROWSER-UNSUPPORTED",
        severity: "blocking",
        message: `Browser "${browser.name}" is not supported.`,
        fix: "Use Chrome or Edge.",
      });
    } else if (browser.majorVersion < 120) {
      issues.push({
        code: "EXT-BROWSER-TOO-OLD",
        severity: "blocking",
        message: `Browser ${browser.name} ${browser.majorVersion} is below the minimum supported version.`,
        fix: "Update Chrome or Edge to the latest stable release.",
      });
    }
  }

  const core = isCoreInfo(input.core) ? input.core : null;
  if (!core) {
    issues.push({
      code: "EXT-CORE-MISSING",
      severity: "blocking",
      message: "Orchords Web Pilot core/native host is not installed.",
      fix: "Install the Web Pilot companion app and grant the native messaging permission.",
    });
  } else if (
    compareVersion(core.version, SUPPORTED_CORE_VERSION_RANGE.min) < 0 ||
    compareVersion(core.version, SUPPORTED_CORE_VERSION_RANGE.max) > 0
  ) {
    issues.push({
      code: "EXT-CORE-VERSION-MISMATCH",
      severity: "blocking",
      message: `Companion core version "${core.version}" is outside the supported range.`,
      fix: `Update the companion to a version within ${SUPPORTED_CORE_VERSION_RANGE.min}–${SUPPORTED_CORE_VERSION_RANGE.max}.`,
    });
  }

  if (!input.pairing) {
    issues.push({
      code: "EXT-PAIRING-MISSING",
      severity: "blocking",
      message: "Extension is not paired with the companion core.",
      fix: "Run the onboarding wizard from the extension popup.",
    });
  } else if (
    typeof input.pairing !== "object" ||
    typeof input.pairing.pairingId !== "string" ||
    input.pairing.pairingId.length === 0
  ) {
    issues.push({
      code: "EXT-PAIRING-CORRUPTED",
      severity: "blocking",
      message: "Stored pairing credential is corrupted.",
      fix: "Use “Reset pairing” in settings, then re-run the onboarding wizard.",
    });
  }

  if (input.lastError?.code === "EXT-NATIVE-DENIED") {
    issues.push({
      code: "EXT-NATIVE-DENIED",
      severity: "blocking",
      message: "The browser denied the native messaging permission for Orchords Web Pilot.",
      fix: "Open chrome://extensions, find Orchords Web Pilot, and re-enable native messaging.",
    });
  } else if (input.lastError?.code === "EXT-NATIVE-DISCONNECTED") {
    issues.push({
      code: "EXT-BRIDGE-UNREACHABLE",
      severity: "error",
      message: "The native bridge disconnected unexpectedly.",
      fix: "Restart the companion core, then click Retry in the popup.",
    });
  }

  if (input.controlState === "error" && !input.lastError) {
    issues.push({
      code: "EXT-CONTROL-ERROR-UNEXPLAINED",
      severity: "warning",
      message: "The control surface is in the error state with no recorded cause.",
      fix: "Click Retry; if the state persists, reset pairing and re-onboard.",
    });
  }

  // Sort by descending severity so the most important issue is at the top.
  issues.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
  const top = issues[0]?.severity ?? "ok";

  return {
    severity: top,
    issues,
    generatedAt: typeof input.now === "function" ? input.now() : Date.now(),
  };
}

export const DIAGNOSTIC_VERSION = 1;
export const DOCTOR_VERSION = 1;
