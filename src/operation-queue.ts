import { randomUUID } from "node:crypto";

export interface OperationQueueOptions {
  /** Maximum operations that may be in-flight at once. Default 1. */
  maxConcurrent?: number;
  /** Maximum operations that may be queued behind in-flight slots. Default 64. */
  queueMax?: number;
  /** Maximum time a caller may wait in the backlog before cancellation. Default 30s. */
  waitTimeoutMs?: number;
  /** Emit lifecycle events for audit/health consumers. Default: no-op. */
  onEvent?: (event: OperationEvent) => void;
}

export type OperationCancellationCode = "cancelled" | "queue_timeout" | "session_disposed";

export type OperationEvent =
  | { kind: "queued"; sessionId: string; opId: string; tool: string; queueDepth: number }
  | {
      kind: "started";
      sessionId: string;
      opId: string;
      tool: string;
      inFlight: number;
      queueWaitMs: number;
      dispatchSequence: number;
    }
  | { kind: "completed"; sessionId: string; opId: string; tool: string; ok: boolean; ms: number }
  | {
      kind: "cancelled";
      sessionId: string;
      opId: string;
      tool: string;
      reason: string;
      code: OperationCancellationCode;
    }
  | { kind: "overflow"; sessionId: string; opId: string; tool: string; queueMax: number };

export interface OperationQueueStats {
  /** Operations currently executing (i.e. holding a concurrency slot). */
  inFlight: number;
  /** Operations waiting for a slot. */
  queued: number;
  /** Cumulative count of operations refused by the overflow guard. */
  overflowed: number;
  /** Cumulative count of operations cancelled before dispatch, including queue timeouts. */
  cancelled: number;
  /** Cumulative count of operations that completed after dispatch (any outcome). */
  completed: number;
  /** Configured limits — useful for `/health` and metrics scrapers. */
  maxConcurrent: number;
  queueMax: number;
}

interface PendingOp {
  opId: string;
  tool: string;
  enqueuedAt: number;
  signal?: AbortSignal;
  start: () => void;
  reject: (err: OperationCancelledError) => void;
  cleanup: () => void;
}

/** Reason returned to a caller cancelled before it gets a dispatch slot. */
export class OperationCancelledError extends Error {
  constructor(
    public readonly opId: string,
    public readonly tool: string,
    public readonly reason: string,
    public readonly code: OperationCancellationCode = "cancelled",
  ) {
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

/**
 * Per-session bounded FIFO scheduler.
 *
 * Queue cancellation is deliberately scoped to work that has not started.
 * Once a task is dispatched, cooperative cancellation belongs to the task
 * and browser/provider layers (issue #36); the queue must never replay an
 * already-started non-idempotent operation.
 */
export class OperationQueue {
  private readonly maxConcurrent: number;
  private readonly queueMax: number;
  private readonly waitTimeoutMs: number;
  public onEvent: (event: OperationEvent) => void;

  private readonly pending: PendingOp[] = [];
  private inFlight = 0;
  private overflowedCount = 0;
  private cancelledCount = 0;
  private completedTotal = 0;
  private dispatchSequence = 0;
  private disposed = false;

  constructor(
    public readonly sessionId: string,
    options: OperationQueueOptions = {},
  ) {
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 1);
    this.queueMax = Math.max(0, options.queueMax ?? 64);
    this.waitTimeoutMs = Math.max(1, options.waitTimeoutMs ?? 30_000);
    this.onEvent = options.onEvent ?? (() => undefined);
  }

  /**
   * Run `fn` once a concurrency slot is available.
   *
   * If `signal` is already aborted, the task never starts. If it aborts
   * while queued, the task is removed from the backlog and its promise is
   * rejected. A queued caller that waits longer than `waitTimeoutMs` is
   * rejected with code `queue_timeout`. Cancellation after dispatch is not
   * interpreted by this queue; running work must cooperatively consume the
   * request signal itself.
   */
  async run<T>(
    tool: string,
    fn: () => Promise<T>,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    const opId = randomUUID();

    if (this.disposed) {
      const err = new OperationCancelledError(opId, tool, "session disposed", "session_disposed");
      this.recordCancelled(opId, tool, err.reason, err.code);
      throw err;
    }

    if (options.signal?.aborted) {
      const reason = signalReason(options.signal);
      const err = new OperationCancelledError(opId, tool, reason, "cancelled");
      this.recordCancelled(opId, tool, err.reason, err.code);
      throw err;
    }

    const enqueuedAt = Date.now();
    if (this.inFlight < this.maxConcurrent && this.pending.length === 0) {
      return this.execute(opId, tool, fn, enqueuedAt);
    }

    if (this.pending.length >= this.queueMax) {
      this.recordOverflow(opId, tool);
      throw new OperationQueueFullError(opId, tool, this.queueMax);
    }

    return this.enqueue(opId, tool, fn, enqueuedAt, options.signal);
  }

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

  /** Abort every queued op and refuse new ones. Running work is not replayed or force-killed. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const queued = this.pending.splice(0);
    for (const op of queued) {
      op.cleanup();
      const err = new OperationCancelledError(op.opId, op.tool, "session disposed", "session_disposed");
      this.recordCancelled(op.opId, op.tool, err.reason, err.code);
      op.reject(err);
    }
  }

  private enqueue<T>(
    opId: string,
    tool: string,
    fn: () => Promise<T>,
    enqueuedAt: number,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let abortHandler: (() => void) | undefined;

      const entry: PendingOp = {
        opId,
        tool,
        enqueuedAt,
        signal,
        start: () => {
          entry.cleanup();
          void this.execute(opId, tool, fn, enqueuedAt).then(resolve, reject);
        },
        reject,
        cleanup: () => {
          if (timeout) clearTimeout(timeout);
          timeout = undefined;
          if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
          abortHandler = undefined;
        },
      };

      this.pending.push(entry);
      this.onEvent({
        kind: "queued",
        sessionId: this.sessionId,
        opId,
        tool,
        queueDepth: this.pending.length,
      });

      if (signal) {
        abortHandler = () => {
          this.cancelPending(entry, signalReason(signal), "cancelled");
        };
        signal.addEventListener("abort", abortHandler, { once: true });
        // Close the race where the signal aborts after run() checked it but
        // before the listener above was installed.
        if (signal.aborted) abortHandler();
      }

      if (this.pending.includes(entry)) {
        timeout = setTimeout(() => {
          this.cancelPending(
            entry,
            `queue wait exceeded ${this.waitTimeoutMs}ms`,
            "queue_timeout",
          );
        }, this.waitTimeoutMs);
      }
    });
  }

  private cancelPending(entry: PendingOp, reason: string, code: OperationCancellationCode): void {
    const idx = this.pending.indexOf(entry);
    if (idx < 0) return;
    this.pending.splice(idx, 1);
    entry.cleanup();
    const err = new OperationCancelledError(entry.opId, entry.tool, reason, code);
    this.recordCancelled(entry.opId, entry.tool, reason, code);
    entry.reject(err);
    this.drain();
  }

  private drain(): void {
    if (this.disposed) return;
    while (this.inFlight < this.maxConcurrent && this.pending.length > 0) {
      const next = this.pending.shift()!;
      next.cleanup();
      if (next.signal?.aborted) {
        const reason = signalReason(next.signal);
        const err = new OperationCancelledError(next.opId, next.tool, reason, "cancelled");
        this.recordCancelled(next.opId, next.tool, reason, err.code);
        next.reject(err);
        continue;
      }
      next.start();
    }
  }

  private async execute<T>(
    opId: string,
    tool: string,
    fn: () => Promise<T>,
    enqueuedAt: number,
  ): Promise<T> {
    this.inFlight += 1;
    const startedAt = Date.now();
    const dispatchSequence = ++this.dispatchSequence;
    this.onEvent({
      kind: "started",
      sessionId: this.sessionId,
      opId,
      tool,
      inFlight: this.inFlight,
      queueWaitMs: Math.max(0, startedAt - enqueuedAt),
      dispatchSequence,
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
      this.drain();
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

  private recordCancelled(
    opId: string,
    tool: string,
    reason: string,
    code: OperationCancellationCode,
  ): void {
    this.cancelledCount += 1;
    this.onEvent({ kind: "cancelled", sessionId: this.sessionId, opId, tool, reason, code });
  }
}

function signalReason(signal: AbortSignal): string {
  const reason = signal.reason;
  if (typeof reason === "string" && reason.length > 0) return reason;
  if (reason instanceof Error && reason.message.length > 0) return reason.message;
  return "aborted";
}
