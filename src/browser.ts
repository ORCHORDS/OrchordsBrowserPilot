import { chromium, type Browser, type Page, type BrowserContext, type ConsoleMessage } from "playwright";

export interface BrowserManager {
  page(): Promise<Page>;
  close(): Promise<void>;
}

export type ExtensionBrowserName = "chrome" | "edge";
export type ExtensionConnectionState = "connected" | "disconnected" | "reconnecting" | "version_mismatch";

export interface ExtensionProviderDescriptorInput {
  browser: ExtensionBrowserName;
  profileId: string;
  tabId: number;
  windowId: number;
  connectionEpoch: string;
  connectionState: ExtensionConnectionState;
  extensionVersion: string;
  protocolVersion: number;
  connectionId: string;
  policyAuthorityId: string;
  nativeMessaging: boolean;
  debugger: boolean;
}

export interface ExtensionProviderDescriptor {
  provider: "extension";
  browser: ExtensionBrowserName;
  transport: "extension";
  connectionState: ExtensionConnectionState;
  connectionEpoch: string;
  target: {
    kind: "tab";
    profileId: string;
    tabId: number;
    windowId: number;
    identity: string;
  };
  ownership: {
    browser: "external";
    context: "external";
    target: "external";
  };
  capabilities: {
    existingTab: true;
    currentTab: true;
    sidePanel: true;
    nativeMessaging: boolean;
    debugger: boolean;
  };
  protocol: {
    extensionVersion: string;
    protocolVersion: number;
  };
  correlation: {
    connectionId: string;
    policyAuthorityId: string;
  };
}

/**
 * Describe an extension-owned browser tab without implying that Web Pilot
 * owns or can silently replace the browser, profile, or tab. Chrome tab IDs
 * are only unique within a browser session, so `connectionEpoch` is part of
 * the canonical target identity. MV3 service-worker restarts reuse the same
 * epoch; a new browser session must mint a new one and therefore cannot
 * inherit authority merely because a numeric tab id is reused.
 */
export function createExtensionProviderDescriptor(
  input: ExtensionProviderDescriptorInput,
): ExtensionProviderDescriptor {
  return {
    provider: "extension",
    browser: input.browser,
    transport: "extension",
    connectionState: input.connectionState,
    connectionEpoch: input.connectionEpoch,
    target: {
      kind: "tab",
      profileId: input.profileId,
      tabId: input.tabId,
      windowId: input.windowId,
      identity: `extension:${input.browser}:${input.profileId}:${input.connectionEpoch}:${input.tabId}`,
    },
    ownership: {
      browser: "external",
      context: "external",
      target: "external",
    },
    capabilities: {
      existingTab: true,
      currentTab: true,
      sidePanel: true,
      nativeMessaging: input.nativeMessaging,
      debugger: input.debugger,
    },
    protocol: {
      extensionVersion: input.extensionVersion,
      protocolVersion: input.protocolVersion,
    },
    correlation: {
      connectionId: input.connectionId,
      policyAuthorityId: input.policyAuthorityId,
    },
  };
}

class LocalBrowserManager implements BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private currentPage: Page | null = null;

  constructor(private readonly headless: boolean) {}

  async page(): Promise<Page> {
    if (this.currentPage && !this.currentPage.isClosed()) return this.currentPage;
    if (!this.browser || !this.browser.isConnected()) {
      this.browser = await chromium.launch({
        headless: this.headless,
        chromiumSandbox: true,
      });
      this.context = null;
      this.currentPage = null;
    }
    if (!this.context) {
      this.context = await this.browser.newContext();
    }
    this.currentPage = await this.context.newPage();
    return this.currentPage;
  }

  async close(): Promise<void> {
    if (this.browser) await this.browser.close();
    this.browser = null;
    this.context = null;
    this.currentPage = null;
  }
}

/**
 * Remote browser manager: persists a stable browser connection, context, and
 * page across calls so multi-step MCP sequences (navigate -> snapshot ->
 * click -> fill -> screenshot) target the same page.
 *
 * Lifecycle rules:
 *   - The Browser is owned by the provider; we never call `browser.close()`.
 *   - The Context is owned by the provider when `wsEndpoint` is set;
 *     `newContext()` on a connectOverCDP endpoint would leak it. Instead we
 *     reuse the default context (or the first existing one) and open pages
 *     against it.
 *   - On `disconnected` we clear cached handles so the next `page()` call
 *     reconnects.
 */
class RemoteBrowserManager implements BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private currentPage: Page | null = null;

  // `headless` is captured for API symmetry with the local manager but
  // `chromium.connect()` does not accept it — the headless flag is set by
  // the provider when it launches the browser.
  constructor(private readonly wsEndpoint: string, _headless: boolean) {}

  async page(): Promise<Page> {
    if (this.currentPage && !this.currentPage.isClosed()) return this.currentPage;

    if (!this.browser || !this.browser.isConnected()) {
      this.browser = await chromium.connect(this.wsEndpoint);
      this.browser.on("disconnected", () => {
        this.browser = null;
        this.context = null;
        this.currentPage = null;
      });
      // Reuse the provider's default context; never call newContext() here —
      // remote providers (Browserless, Steel, etc.) reject stray contexts.
      const contexts = this.browser.contexts();
      this.context = contexts[0] ?? null;
      if (!this.context) {
        // Fall back only when the provider gave us no context (e.g. local
        // connectOverCDP without a session); managed-mode providers should
        // never hit this branch.
        this.context = await this.browser.newContext();
      }
    }

    if (!this.context) throw new Error("Remote browser has no context");

    this.currentPage = await this.context.newPage();
    return this.currentPage;
  }

  async close(): Promise<void> {
    // Close the page we opened but never the browser itself — the provider
    // owns it. We also drop references so the next session reconnects fresh.
    if (this.currentPage && !this.currentPage.isClosed()) {
      await this.currentPage.close().catch(() => undefined);
    }
    this.currentPage = null;
    // Intentionally do NOT close this.context or this.browser.
  }
}

export function createBrowserManager(wsEndpoint: string | undefined, headless: boolean): BrowserManager {
  return wsEndpoint ? new RemoteBrowserManager(wsEndpoint, headless) : new LocalBrowserManager(headless);
}

export type ConsoleSeverity = "debug" | "info" | "warning" | "error";

export interface ConsoleDiagnostic {
  level: string;
  severity: ConsoleSeverity;
  text: string;
  at: number;
  location: { url: string; line: number; column: number };
}

/**
 * Per-session console/network diagnostics buffer. Replaces the module-level
 * arrays that previously leaked state across sessions (issue #3).
 *
 * Each session owns one of these; the registry is dropped with the session.
 */
export interface SessionDiagnostics {
  onConsole(msg: ConsoleMessage): void;
  onRequestFinished(url: string, method: string, status: number, type: string): void;
  onRequestFailed(url: string, method: string, type: string): void;
  console(level: string, limit: number): ConsoleDiagnostic[];
  network(includeStatic: boolean, limit: number): Array<{ url: string; method: string; status: number; type: string }>;
  readonly bounded: { console: number; network: number };
}

const CONSOLE_CAP = 1000;
const NETWORK_CAP = 2000;
const CONSOLE_LEVEL_ORDER = ["debug", "log", "info", "warn", "error"] as const;
const STATIC_RESOURCE_TYPES = new Set(["script", "stylesheet", "image", "font"]);

function normalizedConsoleSeverity(level: string): ConsoleSeverity {
  if (level === "error" || level === "assert") return "error";
  if (level === "warning") return "warning";
  if (level === "debug" || level === "trace") return "debug";
  return "info";
}

function consoleSeverityRank(level: string): number {
  if (level === "warning") return CONSOLE_LEVEL_ORDER.indexOf("warn");
  if (level === "assert") return CONSOLE_LEVEL_ORDER.indexOf("error");
  if (level === "trace") return CONSOLE_LEVEL_ORDER.indexOf("debug");
  if (level === "log") return CONSOLE_LEVEL_ORDER.indexOf("log");
  if (level === "debug" || level === "info" || level === "error") {
    return CONSOLE_LEVEL_ORDER.indexOf(level);
  }
  return CONSOLE_LEVEL_ORDER.indexOf("info");
}

function consoleLocation(msg: ConsoleMessage): ConsoleDiagnostic["location"] {
  const location = msg.location() as unknown as {
    url?: string;
    line?: number;
    column?: number;
    lineNumber?: number;
    columnNumber?: number;
  };
  return {
    url: location.url ?? "",
    line: location.line ?? location.lineNumber ?? 0,
    column: location.column ?? location.columnNumber ?? 0,
  };
}

function isSuccessfulStaticResource(request: { status: number; type: string }): boolean {
  return request.status >= 200 && request.status < 400 && STATIC_RESOURCE_TYPES.has(request.type);
}

export function createDiagnostics(): SessionDiagnostics {
  const consoleBuf: ConsoleDiagnostic[] = [];
  const netBuf: Array<{ url: string; method: string; status: number; type: string }> = [];
  return {
    onConsole(msg) {
      const level = msg.type();
      consoleBuf.push({
        level,
        severity: normalizedConsoleSeverity(level),
        text: msg.text(),
        at: msg.timestamp(),
        location: consoleLocation(msg),
      });
      if (consoleBuf.length > CONSOLE_CAP) consoleBuf.shift();
    },
    onRequestFinished(url, method, status, type) {
      netBuf.push({ url, method, status, type });
      if (netBuf.length > NETWORK_CAP) netBuf.shift();
    },
    onRequestFailed(url, method, type) {
      netBuf.push({ url, method, status: 0, type });
      if (netBuf.length > NETWORK_CAP) netBuf.shift();
    },
    console(level, limit) {
      const min = consoleSeverityRank(level);
      return consoleBuf
        .filter((message) => consoleSeverityRank(message.level) >= min)
        .slice(-limit);
    },
    network(includeStatic, limit) {
      return netBuf
        .filter((request) => includeStatic || !isSuccessfulStaticResource(request))
        .slice(-limit);
    },
    get bounded() {
      return { console: CONSOLE_CAP, network: NETWORK_CAP };
    },
  };
}