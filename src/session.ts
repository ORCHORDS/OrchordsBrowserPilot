import type { Page } from "playwright";
import type { BrowserManager, SessionDiagnostics } from "./browser.js";
import { createDiagnostics } from "./browser.js";
import { RefRegistry } from "./refs.js";
import { OperationQueue, type OperationQueueOptions } from "./operation-queue.js";

/**
 * A logical MCP session: a single browser manager plus its page, the ref
 * registry built from the most recent snapshot, and the per-session console
 * + network diagnostics.
 */
export class Session {
  readonly id: string;
  readonly manager: BrowserManager;
  readonly refs = new RefRegistry();
  readonly diagnostics: SessionDiagnostics;
  readonly ops: OperationQueue;
  private currentPage: Page | null = null;
  private lastSnapshotAt = 0;
  private currentPageGeneration = 0;
  private readonly listenerPages = new WeakSet<Page>();

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
   * Return the active page for this session, lazily creating/adopting one.
   * Every distinct Page object gets its own listeners; replacing a closed
   * Page is a generation boundary and invalidates snapshot refs.
   */
  async page(): Promise<Page> {
    if (!this.currentPage || this.currentPage.isClosed()) {
      const nextPage = await this.manager.page();
      if (nextPage !== this.currentPage) {
        this.currentPage = nextPage;
        this.currentPageGeneration += 1;
        this.refs.clear();
      }
      this.installPageListeners(nextPage);
    }
    return this.currentPage;
  }

  /** Monotonic generation for the currently adopted Page/document state. */
  pageGeneration(): number {
    return this.currentPageGeneration;
  }

  /** Mark that a snapshot has just been taken. */
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
   * Tear down session-owned resources. The queue is disposed first so queued
   * calls reject before their owning request disappears.
   */
  async dispose(): Promise<void> {
    this.ops.dispose();
    const page = this.currentPage;
    this.currentPage = null;
    this.refs.clear();
    if (page && !page.isClosed()) {
      await page.close().catch(() => undefined);
    }
  }

  private installPageListeners(page: Page): void {
    if (this.listenerPages.has(page)) return;
    this.listenerPages.add(page);

    page.on("console", (msg) => this.diagnostics.onConsole(msg));
    page.on("requestfinished", async (req) => {
      const res = await req.response().catch(() => null);
      this.diagnostics.onRequestFinished(req.url(), req.method(), res?.status() ?? 0, req.resourceType());
    });
    page.on("requestfailed", (req) => {
      this.diagnostics.onRequestFailed(req.url(), req.method(), req.resourceType());
    });

    // Any frame navigation can invalidate refs (including refs owned by an
    // iframe), so conservatively advance the whole page generation.
    page.on("framenavigated", () => {
      if (page !== this.currentPage) return;
      this.currentPageGeneration += 1;
      this.refs.clear();
    });

    page.on("close", () => {
      if (page !== this.currentPage) return;
      this.currentPageGeneration += 1;
      this.refs.clear();
      this.currentPage = null;
    });
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

  async sweep(): Promise<number> {
    const now = Date.now();
    const stale: string[] = [];
    for (const [id, entry] of this.sessions) {
      if (now - entry.lastUsed > this.idleMs) stale.push(id);
    }
    await Promise.all(stale.map((id) => this.dispose(id)));
    return stale.length;
  }

  size(): number {
    return this.sessions.size;
  }

  all(): Session[] {
    return Array.from(this.sessions.values(), (entry) => entry.session);
  }
}
