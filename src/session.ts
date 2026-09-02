import type { Page } from "playwright";
import type { BrowserManager, SessionDiagnostics } from "./browser.js";
import { createDiagnostics } from "./browser.js";
import { RefRegistry } from "./refs.js";
import { OperationQueue, type OperationQueueOptions } from "./operation-queue.js";

/**
 * A logical MCP session: a single browser manager plus its page, the ref
 * registry built from the most recent snapshot, and the per-session console
 * + network diagnostics. Dropping the session tears down its page; the
 * underlying manager keeps its browser/context alive across sessions that
 * share an MCP transport (local stdio, or an HTTP request carrying the
 * same Mcp-Session-Id).
 *
 * This is the unit of isolation called for by issue #3.
 */
export class Session {
  readonly id: string;
  readonly manager: BrowserManager;
  readonly refs = new RefRegistry();
  readonly diagnostics: SessionDiagnostics;
  /**
   * Per-session operation queue (issue #104). One slot by default so the
   * gate and Playwright never race on the same page; see
   * `OperationQueue` for the overflow/abort/telemetry contract.
   */
  readonly ops: OperationQueue;
  private currentPage: Page | null = null;
  private lastSnapshotAt = 0;
  private pageListenersInstalled = false;

  constructor(
    id: string,
    manager: BrowserManager,
    queueOptions: OperationQueueOptions = {},
  ) {
    this.id = id;
    this.manager = manager;
    this.diagnostics = createDiagnostics();
    this.ops = new OperationQueue(id, queueOptions);
  }

  /**
   * Return the active page for this session, lazily creating one and
   * installing console/network listeners. The page is cached so subsequent
   * calls reuse it; when the page is closed (e.g. by a navigate that
   * replaces it) the next call will reopen it transparently.
   */
  async page(): Promise<Page> {
    if (!this.currentPage || this.currentPage.isClosed()) {
      this.currentPage = await this.manager.page();
      this.installPageListeners(this.currentPage);
    }
    return this.currentPage;
  }

  /**
   * Invalidate refs and mark that a snapshot has just been taken. Called by
   * the snapshot tool so the next click/type/etc. knows refs are fresh.
   */
  noteSnapshotTaken(): void {
    this.lastSnapshotAt = Date.now();
  }

  /** Convenience for callers that want to clear refs without snapshotting. */
  clearRefs(): void {
    this.refs.clear();
  }

  /** Whether a snapshot has been taken on this session — used in tests. */
  hasSnapshot(): boolean {
    return this.lastSnapshotAt > 0;
  }

  /**
   * Tear down session-owned resources: the page (if we opened it) and its
   * listeners. Does NOT close the manager — that's a transport-level
   * decision (see server.ts).
   *
   * The operation queue is disposed first so any queued calls unblock
   * with an `OperationCancelledError` before their owning request goes
   * away.
   */
  async dispose(): Promise<void> {
    this.ops.dispose();
    if (this.currentPage && !this.currentPage.isClosed()) {
      await this.currentPage.close().catch(() => undefined);
    }
    this.currentPage = null;
    this.refs.clear();
  }

  private installPageListeners(page: Page): void {
    if (this.pageListenersInstalled) return;
    this.pageListenersInstalled = true;
    page.on("console", (msg) => this.diagnostics.onConsole(msg));
    page.on("requestfinished", async (req) => {
      const res = await req.response().catch(() => null);
      this.diagnostics.onRequestFinished(req.url(), req.method(), res?.status() ?? 0, req.resourceType());
    });
    page.on("requestfailed", (req) => {
      this.diagnostics.onRequestFailed(req.url(), req.method(), req.resourceType());
    });
    // Any navigation invalidates outstanding refs.
    page.on("framenavigated", () => this.refs.clear());
  }
}

/**
 * A pool of sessions keyed by string (an MCP session id for HTTP, or a
 * stable id for stdio). Sessions are removed on `dispose(id)`. A periodic
 * sweep removes sessions that haven't been touched for `idleMs` (default 1
 * hour) to avoid unbounded growth on a long-running gateway.
 */
export class SessionRegistry {
  private readonly sessions = new Map<string, { session: Session; lastUsed: number }>();
  constructor(private readonly idleMs: number = 60 * 60 * 1000) {}

  /**
   * Get or create the session for `id`. `factory` is invoked when no
   * session exists yet; the typical factory calls `createBrowserManager`.
   */
  getOrCreate(id: string, factory: (id: string) => Session): Session {
    const existing = this.sessions.get(id);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing.session;
    }
    const session = factory(id);
    this.sessions.set(id, { session, lastUsed: Date.now() });
    return session;
  }

  async dispose(id: string): Promise<void> {
    const entry = this.sessions.get(id);
    if (!entry) return;
    await entry.session.dispose();
    this.sessions.delete(id);
  }

  async disposeAll(): Promise<void> {
    await Promise.all(Array.from(this.sessions.keys()).map((id) => this.dispose(id)));
  }

  /** Drop sessions that haven't been touched for idleMs (idempotent). */
  async sweep(): Promise<number> {
    const now = Date.now();
    const stale: string[] = [];
    for (const [id, entry] of this.sessions) {
      if (now - entry.lastUsed > this.idleMs) stale.push(id);
    }
    await Promise.all(stale.map((id) => this.dispose(id)));
    return stale.length;
  }

  /** Number of live sessions — exposed for tests and diagnostics. */
  size(): number {
    return this.sessions.size;
  }

  /**
   * Iterate live sessions. Order is undefined. Callers that need to read
   * stats across all sessions (e.g. `/health`, metrics scrapers) should
   * snapshot — mutating the registry while iterating is unsupported.
   */
  all(): Session[] {
    return Array.from(this.sessions.values(), (e) => e.session);
  }
}
