/**
 * Per-session operation queue (issue #104).
 *
 * A Session owns ONE Playwright page and ONE policy gate. Concurrent tool
 * calls on the same session used to race each other inside Playwright and
 * against the gate's TOCTOU recompute. `OperationQueue` collapses the
 * dispatch path onto a single in-flight slot plus a bounded FIFO backlog:
 *
 *   1. `maxConcurrent` (default 1) slots run at the same time; further
 *      callers queue in arrival order.
 *   2. The queue holds at most `queueMax` (default 64) pending tasks;
 *      overflow returns immediately with a structured 503-shaped error so
 *      the caller can back off without deadlocking.
 *   3. An `AbortSignal` per call lets the caller (the transport layer) cut
 *      a queued task loose when its client disconnects. Already-running
 *      work is unaffected ��� the gate's `decision` and Playwright's
 *      navigation are not undone by late aborts.
 *   4. Telemetry: `stats()` exposes live + queued counts; `onEvent` fires
 *      for queued, started, completed, cancelled, and overflow transitions
 *      so the audit log and `/health` see them.
 *
 * The queue is intentionally tiny and dependency-free. It owns its own
 * mutable state per Session, so `SessionRegistry.sweep` continues to be
 * the single GC point — disposal calls `dispose()` on the queue to release
 * any pending callers.
 */

export interface OperationQueueOptions {
  /** Maximum operations that may be in-flight at once. Default 1. */
  maxConcurrent?: number;
  /** Maximum operations that may be queued behind an in-flight slot. Default 64. */
  queueMax?: number;
  /** Emit lifecycle events for audit/health consumers. Default: no-op. */
  onEvent?: (event: OperationEvent) => void;
}

export type OperationEvent =
  | { kind: "queued"; sessionId: string; opId: string; tool: string; queueDepth: number }
  | { kind: "started"; sessionId: string; opId: string; tool: string; inFlight: number }
  | { kind: "completed"; sessionId: string; opId: string; tool: string; ok: boolean; ms: number }
  | { kind: "cancelled"; sessionId: string; opId: string; tool: string; reason: string }
  | { kind: "overflow"; sessionId: string; opId: string; tool: string; queueMax: number };

export interface OperationQueueStats {
  /** Operations currently executing (i.e. holding a concurrency slot). */
  inFlight: number;
  /** Operations waiting for a slot. */
  queued: number;
  /** Cumulative count of operations that have been refused by the overflow guard. */
  overflowed: number;
  /** Cumulative count of operations that were aborted before they could run. */
  cancelled: number;
  /** Cumulative count of operations that completed (any outcome). */
  completed: number;
  /** Configured limits — useful for `/health` and metrics scrapers. */
  maxConcurrent: number;
  queueMax: number;
}

interface PendingOp {
  opId: string;
  tool: string;
  /** Resolves when the queue hands control to this op. */
  release: () => void;
  /** Rejects the queued promise — used by `dispose()` to refuse the op. */
  reject: (err: OperationCancelledError) => void;
  /** Aborts the wait so callers can react to a closed transport. */
  signal: AbortSignal;
}

/** Reason returned to a caller whose `signal` aborts before it gets a slot. */
export class OperationCancelledError extends Error {
  constructor(public readonly opId: string, public readonly tool: string, public readonly reason: string) {
    super(`operation ${tool} cancelled: ${reason}`);
    this.name = "OperationCancelledError";
  }
}

/** Reason returned to a caller dropped by the overflow guard. */
export class OperationQueueFullError extends Error {
  constructor(
    public readonly opId: string,
    public readonly tool: string,
    public readonly queueMax: number,
  ) {
    super(`operation queue full (limit ${queueMax}); refusing ${tool}`);
    this.name = "OperationQueueFullError";
  }
}

export class OperationQueue {
  private readonly maxConcurrent: number;
  private readonly queueMax: number;
  /**
   * Mutable listener so the owning server can wire this queue into its
   * audit sink after construction (each `buildServer()` creates its own
   * MemoryAuditSink, and we don't want `Session` to know about that).
   */
  public onEvent: (event: OperationEvent) => void;

  /** Tasks waiting for a concurrency slot, in FIFO order. */
  private readonly pending: PendingOp[] = [];
  /** Tasks that have been granted a slot and are currently executing. */
  private inFlight = 0;
  private overflowedCount = 0;
  private cancelledCount = 0;
  private completedTotal = 0;

  private disposed = false;

  constructor(
    public readonly sessionId: string,
    options: OperationQueueOptions = {},
  ) {
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 1);
    this.queueMax = Math.max(0, options.queueMax ?? 64);
    this.onEvent = options.onEvent ?? (() => undefined);
  }

  /**
   * Run `fn` once a concurrency slot is available. Returns the value `fn`
   * resolves with. Throws `OperationCancelledError` if the caller's
   * `signal` aborts before a slot opens, or `OperationQueueFullError` if
   * the backlog is already at `queueMax`.
   *
   * The returned promise resolves only AFTER `fn` resolves — there is no
   * "fire and forget" path so callers can `await` and propagate errors
   * uniformly.
   */
  async run<T>(
    tool: string,
    fn: () => Promise<T>,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    if (this.disposed) {
      throw new OperationCancelledError("disposed", tool, "session disposed");
    }
    const opId = randomOpId();
    const signal = options.signal ?? undefined;

    // Fast path: a slot is free and the backlog is empty — take it
    // immediately without queueing. This is the common case for stdio and
    // for low-concurrency HTTP clients.
    if (this.inFlight < this.maxConcurrent && this.pending.length === 0) {
      return this.execute(opId, tool, fn);
    }

    // Otherwise we have to enqueue. Check the overflow guard first so we
    // never hold the slot of a caller we are about to refuse.
    if (this.pending.length >= this.queueMax) {
      this.recordOverflow(opId, tool);
      throw new OperationQueueFullError(opId, tool, this.queueMax);
    }

    return this.enqueue(opId, tool, fn, signal);
  }

  /**
   * Snapshot of live counters — used by `/health`, audit sinks, and tests.
   */
  stats(): OperationQueueStats {
    return {
      inFlight: this.inFlight,
      queued: this.pending.length,
      overflowed: this.overflowedCount,
      cancelled: this.cancelledCount,
      completed: this.completedTotal,
      maxConcurrent: this.maxConcurrent,
      queueMax: this.queueMax,
    };
  }

  /** Abort every queued op and refuse new ones. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const reason = "session disposed";
    while (this.pending.length > 0) {
      const op = this.pending.shift()!;
      this.recordCancelled(op.opId, op.tool, reason);
      op.reject(new OperationCancelledError(op.opId, op.tool, reason));
    }
  }

  // ─── internals ─────────────────────────────────────────────────────

  private enqueue<T>(
    opId: string,
    tool: string,
    fn: () => Promise<T>,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let release!: () => void;
      const slotPromise = new Promise<void>((res) => {
        release = res;
      });
      const entry: PendingOp = {
        opId,
        tool,
        signal: signal ?? new AbortController().signal,
        release,
        // Forward to the outer reject so dispose() can short-circuit
        // pending callers instead of letting them run.
        reject: (err) => reject(err),
      };
      this.pending.push(entry);
      this.onEvent({
        kind: "queued",
        sessionId: this.sessionId,
        opId,
        tool,
        queueDepth: this.pending.length,
      });

      const onAbort = (sig: AbortSignal) => {
        const idx = this.pending.indexOf(entry);
        if (idx < 0) return; // already running or completed
        this.pending.splice(idx, 1);
        const reason = sig.reason
          ? typeof sig.reason === "string"
            ? sig.reason
            : sig.reason instanceof Error
              ? sig.reason.message
              : "aborted"
          : "aborted";
        this.recordCancelled(opId, tool, reason);
        // The slot will never fire for this op — release it so the
        // executor's await doesn't leak. We resolve slotPromise so the
        // downstream `slotPromise.then(...)` resolves with a rejection
        // instead of hanging.
        release();
        reject(new OperationCancelledError(opId, tool, reason));
      };

      const sig = entry.signal;
      if (sig.aborted) {
        onAbort(sig);
        return;
      }
      sig.addEventListener("abort", () => onAbort(sig), { once: true });

      slotPromise
        .then(async () => {
          if (sig.aborted) {
            throw new OperationCancelledError(opId, tool, sigAbortedReason(sig));
          }
          return this.execute(opId, tool, fn);
        })
        .then(resolve, reject);
    });
  }

  private async execute<T>(opId: string, tool: string, fn: () => Promise<T>): Promise<T> {
    this.inFlight += 1;
    const startedAt = Date.now();
    this.onEvent({
      kind: "started",
      sessionId: this.sessionId,
      opId,
      tool,
      inFlight: this.inFlight,
    });
    let ok = true;
    try {
      return await fn();
    } catch (err) {
      ok = false;
      throw err;
    } finally {
      this.inFlight -= 1;
      this.completedTotal += 1;
      this.onEvent({
        kind: "completed",
        sessionId: this.sessionId,
        opId,
        tool,
        ok,
        ms: Date.now() - startedAt,
      });
      const next = this.pending.shift();
      if (next) next.release();
    }
  }

  private recordOverflow(opId: string, tool: string): void {
    this.overflowedCount += 1;
    this.onEvent({
      kind: "overflow",
      sessionId: this.sessionId,
      opId,
      tool,
      queueMax: this.queueMax,
    });
  }

  private recordCancelled(opId: string, tool: string, reason: string): void {
    this.cancelledCount += 1;
    this.onEvent({ kind: "cancelled", sessionId: this.sessionId, opId, tool, reason });
  }
}

/** Build a short id without pulling in `crypto`; collision risk is local. */
function randomOpId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function sigAbortedReason(signal: AbortSignal): string {
  const r = (signal as unknown as { reason?: unknown }).reason;
  if (typeof r === "string") return r;
  if (r instanceof Error) return r.message;
  return "aborted";
}