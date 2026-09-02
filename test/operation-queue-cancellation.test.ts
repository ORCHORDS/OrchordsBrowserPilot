import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  OperationCancelledError,
  OperationQueue,
  type OperationEvent,
} from "../src/operation-queue.ts";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("OperationQueue cancellation and queue deadlines (#104)", () => {
  it("never dispatches a call whose signal was already aborted", async () => {
    const q = new OperationQueue("pre-aborted");
    const controller = new AbortController();
    controller.abort("request already cancelled");
    let ran = false;

    await assert.rejects(
      q.run(
        "browser_click",
        async () => {
          ran = true;
        },
        { signal: controller.signal },
      ),
      (err: unknown) => {
        assert.ok(err instanceof OperationCancelledError);
        const cancelErr = err as OperationCancelledError;
        assert.equal(cancelErr.code, "cancelled");
        assert.equal(cancelErr.reason, "request already cancelled");
        return true;
      },
    );

    assert.equal(ran, false);
    assert.equal(q.stats().cancelled, 1);
    assert.equal(q.stats().completed, 0);
  });

  it("bounds queue wait time and removes timed-out work without dispatching it", async () => {
    const q = new OperationQueue("deadline", { waitTimeoutMs: 25 });
    const blocker = deferred<void>();
    let timedOutRan = false;

    const first = q.run("first", async () => blocker.promise);
    await Promise.resolve();

    const timedOut = q.run("second", async () => {
      timedOutRan = true;
    });

    await assert.rejects(timedOut, (err: unknown) => {
      assert.ok(err instanceof OperationCancelledError);
      const timeoutErr = err as OperationCancelledError;
      assert.equal(timeoutErr.code, "queue_timeout");
      assert.match(timeoutErr.reason, /queue wait exceeded 25ms/);
      return true;
    });

    assert.equal(timedOutRan, false);
    assert.equal(q.stats().queued, 0);
    assert.equal(q.stats().cancelled, 1);

    blocker.resolve();
    await first;
  });

  it("cleans a cancelled backlog entry and dispatches the next FIFO caller", async () => {
    const q = new OperationQueue("cancel-drain", { waitTimeoutMs: 1_000 });
    const blocker = deferred<void>();
    const controller = new AbortController();
    const order: string[] = [];

    const first = q.run("first", async () => {
      order.push("first");
      await blocker.promise;
    });
    await Promise.resolve();

    const cancelled = q.run(
      "cancelled",
      async () => {
        order.push("cancelled");
      },
      { signal: controller.signal },
    );
    const third = q.run("third", async () => {
      order.push("third");
    });

    controller.abort("client disconnected");
    await assert.rejects(cancelled, OperationCancelledError);

    blocker.resolve();
    await Promise.all([first, third]);
    assert.deepEqual(order, ["first", "third"]);
  });

  it("emits stable operation IDs plus queue-wait and dispatch-order telemetry", async () => {
    const events: OperationEvent[] = [];
    const q = new OperationQueue("telemetry", { onEvent: (event) => events.push(event) });
    const blocker = deferred<void>();

    const first = q.run("first", async () => blocker.promise);
    await Promise.resolve();
    const second = q.run("second", async () => undefined);

    blocker.resolve();
    await Promise.all([first, second]);

    const starts = events.filter((event) => event.kind === "started");
    assert.equal(starts.length, 2);
    assert.notEqual(starts[0].opId, starts[1].opId);
    assert.match(starts[0].opId, /^[0-9a-f-]{36}$/i);
    assert.match(starts[1].opId, /^[0-9a-f-]{36}$/i);
    assert.equal(starts[0].dispatchSequence, 1);
    assert.equal(starts[1].dispatchSequence, 2);
    assert.ok(starts[0].queueWaitMs >= 0);
    assert.ok(starts[1].queueWaitMs >= 0);
  });
});
