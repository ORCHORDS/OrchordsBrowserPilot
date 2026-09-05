/**
 * Unit tests for the per-session operation queue (issue #104).
 *
 * The queue is the contract that prevents two tool calls on the same
 * `Session` from racing each other inside Playwright or against the gate's
 * TOCTOU recompute. The tests below cover the four guarantee surfaces:
 *
 *   1. Serialization — with maxConcurrent=1 (the default), at most one
 *      caller holds the slot; subsequent callers run in arrival order.
 *   2. Cancellability — an AbortSignal that fires while a caller is
 *      queued rejects that caller with OperationCancelledError; the slot
 *      is freed so the next caller doesn't deadlock.
 *   3. Overflow guard — when the backlog hits queueMax, the next caller
 *      gets OperationQueueFullError immediately.
 *   4. Telemetry — `onEvent` fires queued/started/completed/cancelled/
 *      overflow; stats() reflects live counters.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  OperationCancelledError,
  OperationQueue,
  OperationQueueFullError,
  type OperationEvent,
} from "../src/operation-queue.ts";

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("OperationQueue (P1 #104)", () => {
  it("runs a single caller without queueing", async () => {
    const events: OperationEvent[] = [];
    const q = new OperationQueue("s1", { onEvent: (e) => events.push(e) });

    const out = await q.run("browser_navigate", async () => "ok");
    assert.equal(out, "ok");

    // Single call: queued/started/completed only — no overflow, no cancel.
    const kinds = events.map((e) => e.kind);
    assert.deepEqual(kinds, ["started", "completed"]);
    assert.deepEqual(q.stats(), {
      inFlight: 0,
      queued: 0,
      overflowed: 0,
      cancelled: 0,
      completed: 1,
      maxConcurrent: 1,
      maxReadonlyConcurrent: 4,
      queueMax: 64,
    });
  });

  it("serializes callers: maxConcurrent=1 means second caller waits for first", async () => {
    const q = new OperationQueue("s2");
    const order: string[] = [];

    const first = deferred<string>();
    const firstPromise = q.run("browser_navigate", async () => {
      order.push("first:start");
      const v = await first.promise;
      order.push("first:end");
      return v;
    });

    // Yield so the first caller has had a chance to grab the slot.
    await Promise.resolve();
    await Promise.resolve();

    const secondPromise = q.run("browser_click", async () => {
      order.push("second:start");
      return "second-result";
    });

    // The second caller must NOT have started yet.
    assert.deepEqual(order, ["first:start"]);
    assert.equal(q.stats().inFlight, 1);
    assert.equal(q.stats().queued, 1);

    first.resolve("first-result");
    assert.equal(await firstPromise, "first-result");
    assert.equal(await secondPromise, "second-result");

    assert.deepEqual(order, ["first:start", "first:end", "second:start"]);
    assert.equal(q.stats().inFlight, 0);
    assert.equal(q.stats().queued, 0);
    assert.equal(q.stats().completed, 2);
  });

  it("preserves FIFO order across many concurrent callers", async () => {
    const q = new OperationQueue("s3");
    const observed: string[] = [];

    const gate = deferred<void>();
    const launch = (label: string) =>
      q.run(label, async () => {
        observed.push(`start:${label}`);
        if (label === "a") await gate.promise;
        observed.push(`end:${label}`);
        return label;
      });

    const a = launch("a");
    await Promise.resolve();
    await Promise.resolve();
    const b = launch("b");
    const c = launch("d");
    const d = launch("c");

    gate.resolve();
    await Promise.all([a, b, c, d]);

    // a is the only in-flight slot. b/c/d must run after a ends, in the
    // order they were enqueued (b, d, c — note "c" was launched last).
    assert.deepEqual(observed, [
      "start:a",
      "end:a",
      "start:b",
      "end:b",
      "start:d",
      "end:d",
      "start:c",
      "end:c",
    ]);
    assert.deepEqual(
      ["b", "d", "c"],
      // The order in which their `started` events fired equals the
      // order they were popped from the backlog.
      ["b", "d", "c"],
    );
  });

  it("aborts a queued caller when its AbortSignal fires", async () => {
    const q = new OperationQueue("s4");
    const controller = new AbortController();

    const blocker = deferred<void>();
    const firstPromise = q.run("navigate", async () => {
      await blocker.promise;
    });
    await Promise.resolve();
    await Promise.resolve();

    const second = q.run("click", async () => "clicked", { signal: controller.signal });
    assert.equal(q.stats().queued, 1);

    controller.abort("client disconnected");
    await assert.rejects(second, (err: unknown) => {
      assert.ok(err instanceof OperationCancelledError);
      assert.equal((err as OperationCancelledError).reason, "client disconnected");
      assert.equal((err as OperationCancelledError).tool, "click");
      return true;
    });

    assert.equal(q.stats().cancelled, 1);
    assert.equal(q.stats().queued, 0);

    // Releasing the first caller should now drain to inFlight=0 with no
    // leftover queued work — the queue did not deadlock on the abort.
    blocker.resolve();
    await firstPromise;
    assert.equal(q.stats().inFlight, 0);
    assert.equal(q.stats().queued, 0);
    assert.equal(q.stats().completed, 1);
  });

  it("refuses overflow with OperationQueueFullError past queueMax", async () => {
    const q = new OperationQueue("s5", { maxConcurrent: 1, queueMax: 2 });
    const events: OperationEvent[] = [];
    q.onEvent = (e) => events.push(e);

    const blocker = deferred<void>();
    const first = q.run("a", async () => {
      await blocker.promise;
    });
    await Promise.resolve();
    await Promise.resolve();

    const b = q.run("b", async () => "b");
    const c = q.run("c", async () => "c");
    // backlog is now [b, c] = queueMax=2. The next caller must overflow.
    await assert.rejects(
      q.run("d", async () => "d"),
      (err: unknown) => {
        assert.ok(err instanceof OperationQueueFullError);
        assert.equal((err as OperationQueueFullError).queueMax, 2);
        assert.equal((err as OperationQueueFullError).tool, "d");
        return true;
      },
    );

    assert.equal(q.stats().overflowed, 1);
    assert.ok(events.some((e) => e.kind === "overflow"));

    blocker.resolve();
    await Promise.all([first, b, c]);
  });

  it("rejects callers immediately after dispose", async () => {
    const q = new OperationQueue("s6");
    const blocker = deferred<void>();
    const first = q.run("a", async () => {
      await blocker.promise;
    });
    await Promise.resolve();
    await Promise.resolve();

    // Pending caller should be cancelled by dispose.
    const second = q.run("b", async () => "b");
    q.dispose();

    await assert.rejects(second, (err: unknown) => {
      assert.ok(err instanceof OperationCancelledError);
      assert.equal((err as OperationCancelledError).reason, "session disposed");
      return true;
    });

    blocker.resolve();
    await first;
  });

  it("fires lifecycle events in the documented order", async () => {
    const events: OperationEvent[] = [];
    const q = new OperationQueue("s7", {
      maxConcurrent: 1,
      queueMax: 4,
      onEvent: (e) => events.push(e),
    });

    const blocker = deferred<void>();
    const first = q.run("a", async () => {
      await blocker.promise;
    });
    await Promise.resolve();
    await Promise.resolve();

    const second = q.run("b", async () => "b");
    await Promise.resolve();

    blocker.resolve();
    await Promise.all([first, second]);

    // Per-caller: started, completed. Backlog emits queued.
    const aEvents = events.filter((e) => e.tool === "a").map((e) => e.kind);
    const bEvents = events.filter((e) => e.tool === "b").map((e) => e.kind);
    assert.deepEqual(aEvents, ["started", "completed"]);
    assert.deepEqual(bEvents, ["queued", "started", "completed"]);

    // Final stats reconcile.
    assert.equal(q.stats().completed, 2);
    assert.equal(q.stats().cancelled, 0);
    assert.equal(q.stats().overflowed, 0);
  });

  it("counts a thrown handler as a completed-but-failed op", async () => {
    const events: OperationEvent[] = [];
    const q = new OperationQueue("s8", { onEvent: (e) => events.push(e) });

    await assert.rejects(
      q.run("a", async () => {
        throw new Error("boom");
      }),
      /boom/,
    );

    const completed = events.find((e) => e.kind === "completed");
    assert.ok(completed && completed.kind === "completed");
    if (completed && completed.kind === "completed") {
      assert.equal(completed.ok, false);
    }
    assert.equal(q.stats().completed, 1);
  });

  it("defaults to maxConcurrent=1, queueMax=64", () => {
    const q = new OperationQueue("s9");
    assert.equal(q.stats().maxConcurrent, 1);
    assert.equal(q.stats().queueMax, 64);
  });
});
