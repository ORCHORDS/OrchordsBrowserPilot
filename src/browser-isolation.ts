import type { LaunchOptions } from "playwright";

/**
 * Browser process isolation policy for issue #106.
 *
 * `trusted-local` preserves the existing self-host/developer behavior. It does
 * not claim that Chromium's process sandbox is effective and must not be used
 * as evidence of multi-tenant isolation.
 *
 * `require-chromium-sandbox` explicitly asks Playwright to enable Chromium's
 * process sandbox. If the host cannot provide a usable sandbox (for example an
 * Ubuntu/AppArmor environment that blocks the required user namespace), the
 * browser launch is expected to fail rather than silently fall back to
 * `--no-sandbox` semantics.
 */
export type BrowserIsolationMode =
  | "trusted-local"
  | "require-chromium-sandbox";

export const DEFAULT_BROWSER_ISOLATION_MODE: BrowserIsolationMode = "trusted-local";

export interface BrowserIsolationCapability {
  mode: BrowserIsolationMode;
  chromiumSandboxRequested: boolean;
  /**
   * This is deliberately a claim about what Web Pilot requested, not an
   * attestation that the kernel/browser sandbox is effective. Runtime
   * attestation and outer-isolation reporting remain owned by #106.
   */
  enforcement: "trusted-local" | "fail-closed-request";
}

export function browserIsolationCapability(
  mode: BrowserIsolationMode = DEFAULT_BROWSER_ISOLATION_MODE,
): BrowserIsolationCapability {
  if (mode === "require-chromium-sandbox") {
    return {
      mode,
      chromiumSandboxRequested: true,
      enforcement: "fail-closed-request",
    };
  }
  return {
    mode: "trusted-local",
    chromiumSandboxRequested: false,
    enforcement: "trusted-local",
  };
}

/**
 * Produce only the isolation-sensitive Playwright launch fields. Callers can
 * merge these into their normal launch options without duplicating policy.
 */
export function browserIsolationLaunchOptions(
  mode: BrowserIsolationMode = DEFAULT_BROWSER_ISOLATION_MODE,
): Pick<LaunchOptions, "chromiumSandbox"> {
  return {
    chromiumSandbox: mode === "require-chromium-sandbox",
  };
}
