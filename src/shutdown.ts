/**
 * Process-lifecycle shutdown controller (issue #78).
 *
 * One idempotent shutdown controller handles SIGTERM, SIGINT, stdin EOF, and
 * the `process.exit()` path in stdio mode, plus HTTP `server.close()` in
 * HTTP mode. The controller guards against:
 *
 *   - re-entry (repeated signals/EOF cannot double-run cleanup),
 *   - hung cleanup steps blocking the process forever
 *     (a `forceExitAfterMs` watchdog escalates to a non-zero exit),
 *   - silent crashes that leave the worker accepting traffic
 *     (`uncaughtException` / `unhandledRejection` are wired in).
 *
 * Callers register async cleanup hooks with `addCleanup()`; the controller
 * runs them serially in registration order, then resolves. Hooks that throw
 * are recorded but never block later hooks. A drain readiness flag
 * (`isDraining`) lets the HTTP `/ready` endpoint return 503 once draining
 * begins, so orchestrator probes honour the grace window.
 */

export type ShutdownTrigger =
  | "sigterm"
  | "sigint"
  | "stdin-eof"
  | "http-server-closed"
  | "uncaught-exception"
  | "unhandled-rejection"
  | "explicit";

export interface ShutdownHookOptions {
  /** Human-readable name, used in error messages and structured logs. */
  readonly name: string;
  /** Async cleanup function. Throws are caught and recorded. */
  readonly run: () => Promise<void> | void;
  /** Optional per-hook deadline in ms; capped to the controller's
   *  `forceExitAfterMs - 50ms` so a bad hook can never by itself
   *  delay the watchdog. */
  readonly timeoutMs?: number;
}

export interface ShutdownControllerOptions {
  /** Total grace budget for cleanup to finish, default 5000 ms. */
  readonly graceMs?: number;
  /** Fallback watchdog: if cleanup hasn't returned by `forceExitAfterMs`,
   *  exit non-zero. Default 10000 ms (clamped to ≥ graceMs + 5000). */
  readonly forceExitAfterMs?: number;
  /** Optional sink for structured lifecycle events. Tests use this. */
  readonly onLifecycle?: (event: ShutdownLifecycleEvent) => void;
}

export interface ShutdownLifecycleEvent {
  readonly kind:
    | "draining"
    | "cleanup-running"
    | "cleanup-finished"
    | "cleanup-failed"
    | "grace-exceeded"
    | "stopped"
    | "force-exit";
  readonly trigger?: ShutdownTrigger;
  readonly name?: string;
  readonly ms?: number;
  readonly error?: string;
}

interface RegisteredHook {
  readonly name: string;
  readonly run: () => Promise<void> | void;
  readonly timeoutMs: number;
}

export interface ShutdownController {
  /** True once any trigger has fired; cleanup has either run or is running. */
  readonly isDraining: () => boolean;
  /** Idempotent trigger. Returns the same promise for repeated calls. */
  readonly trigger: (reason: ShutdownTrigger) => Promise<void>;
  /** Register a cleanup step. Run in registration order on `trigger`.
   *  Returns an unsubscribe function. */
  readonly addCleanup: (hook: ShutdownHookOptions) => () => void;
  /** Resolve when drain finishes (clean stop or force-exit). Useful for
   *  tests that need to await shutdown before asserting. */
  readonly whenDone: () => Promise<void>;
  /** Wire SIGTERM/SIGINT/uncaughtException/unhandledRejection into
   *  `trigger`. Idempotent — calling twice is a no-op. */
  readonly wireProcessSignals: () => void;
  /** Read-only list of currently-registered cleanup names, in registration
   *  order. Test-only. */
  readonly hookNames: () => readonly string[];
}

function defaultNow(): number {
  return Date.now();
}

/**
 * Module-private idempotency flag for `wireProcessSignals`. Stored in
 * `globalThis` so multiple controllers in the same process (e.g. across
 * tests) don't double-bind `process.once`.
 */
const WIRE_INSTALLED_KEY = Symbol.for("orchords.shutdown.wireInstalled");

export function createShutdownController(
  options: ShutdownControllerOptions = {},
): ShutdownController {
  const graceMs = options.graceMs ?? 5_000;
  const forceExitAfterMs = Math.max(
    graceMs + 5_000,
    options.forceExitAfterMs ?? 10_000,
  );
  const onLifecycle = options.onLifecycle;

  const hooks: RegisteredHook[] = [];
  let drainPromise: Promise<void> | null = null;
  let draining = false;

  const emit = (event: ShutdownLifecycleEvent): void => {
    if (onLifecycle) {
      try { onLifecycle(event); } catch { /* never let the sink crash shutdown */ }
    }
  };

  function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`shutdown hook "${label}" exceeded ${ms}ms`)),
        ms,
      );
      p.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (err) => { clearTimeout(timer); reject(err); },
      );
    });
  }

  async function runCleanup(trigger: ShutdownTrigger): Promise<void> {
    const started = defaultNow();
    emit({ kind: "draining", trigger });
    for (const hook of hooks) {
      emit({ kind: "cleanup-running", trigger, name: hook.name });
      try {
        await withTimeout(Promise.resolve(hook.run()), hook.timeoutMs, hook.name);
        emit({ kind: "cleanup-finished", trigger, name: hook.name });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit({ kind: "cleanup-failed", trigger, name: hook.name, error: message });
      }
    }
    const elapsed = defaultNow() - started;
    if (elapsed > graceMs) {
      emit({ kind: "grace-exceeded", trigger, ms: elapsed });
    }
    emit({ kind: "stopped", trigger, ms: elapsed });
  }

  function trigger(reason: ShutdownTrigger): Promise<void> {
    if (drainPromise) return drainPromise;
    draining = true;
    drainPromise = (async () => {
      // The watchdog fences hung cleanup. Note `process.exit` is synchronous
      // and the timer does NOT need `unref` because once we reach this
      // branch the only alive activity is the controller itself; without
      // the watchdog the process would sit forever on a hung hook.
      const watchdog = setTimeout(() => {
        emit({ kind: "force-exit", trigger: reason, ms: forceExitAfterMs });
        // The watchdog fires only after we exceeded the deadline — something
        // didn't finish in time, so we deliberately use a non-zero exit.
        process.exit(1);
      }, forceExitAfterMs);
      try {
        await runCleanup(reason);
      } finally {
        clearTimeout(watchdog);
      }
    })();
    return drainPromise;
  }

  function addCleanup(hook: ShutdownHookOptions): () => void {
    if (typeof hook?.run !== "function") {
      throw new Error("shutdown hook requires a run() function");
    }
    const maxHookTimeout = Math.max(1, Math.min(hook.timeoutMs ?? graceMs, forceExitAfterMs - 50));
    const entry: RegisteredHook = { name: hook.name, run: hook.run, timeoutMs: maxHookTimeout };
    hooks.push(entry);
    return () => {
      const idx = hooks.findIndex((h) => h.name === entry.name);
      if (idx >= 0) hooks.splice(idx, 1);
    };
  }

  function hookNames(): readonly string[] {
    return hooks.map((h) => h.name);
  }

  function whenDone(): Promise<void> {
    if (drainPromise) return drainPromise;
    return new Promise((resolve) => setImmediate(resolve));
  }

  function wireProcessSignals(): void {
    const g = globalThis as unknown as Record<symbol, boolean>;
    if (g[WIRE_INSTALLED_KEY]) return;
    g[WIRE_INSTALLED_KEY] = true;

    const onSignal = (sig: "SIGINT" | "SIGTERM"): void => {
      const t = sig.toLowerCase() as ShutdownTrigger;
      if (draining) {
        // Second signal mid-drain = escalation. Skip cleanup, exit now.
        emit({ kind: "force-exit", trigger: t });
        process.exit(1);
      }
      void trigger(t);
    };

    process.once("SIGINT", () => onSignal("SIGINT"));
    process.once("SIGTERM", () => onSignal("SIGTERM"));

    process.once("uncaughtException", (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      // Safe, no-stack diagnostic per #78.
      process.stderr.write(`orchords-web-pilot: uncaught exception (${message})\n`);
      void trigger("uncaught-exception");
    });
    process.once("unhandledRejection", (reason: unknown) => {
      const message = reason instanceof Error ? reason.message : String(reason);
      process.stderr.write(`orchords-web-pilot: unhandled rejection (${message})\n`);
      void trigger("unhandled-rejection");
    });
  }

  function isDraining(): boolean {
    return draining;
  }

  return {
    isDraining,
    trigger,
    addCleanup,
    whenDone,
    wireProcessSignals,
    hookNames,
  };
}
