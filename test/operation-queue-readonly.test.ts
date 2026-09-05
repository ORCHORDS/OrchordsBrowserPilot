/**
 * Lane-split coverage for issue #104 AC 4.
 *
 * The queue keeps a single FIFO of pending ops but partitions concurrency
 * across two slot pools — `mutating` (single slot, default) and `readonly`
 * (`maxReadonlyConcurrent` slots, default 4). Read-only ops sharing the
 * FIFO never jump ahead of an in-flight mutating op, so an in-flight
 * `browser_navigate` is honored ahead of any queued `browser_snapshot`.
 * Independent read-only observations, on the other hand, run in parallel.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  OperationQueue,
  OperationCancelledError,
  OperationQueueFullError,
  type OperationEvent,
} from "../src/operation-queue.js";

const PER_CALL_MS = 120;
const SLACK_MS = 80;

/** A controlled-async function whose `start` lets the test release it later. */
function deferredWork(): { promise: Promise<string>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<string>((res) => {
    resolve = () => res("ok");
  });
  return { promise, resolve };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function okAfter(ms: number): Promise<string> {
  await sleep(ms);
  return "ok";
}

describe("OperationQueue — read-only lane split (issue #104 AC 4)", () => {
  it("three mutating ops serialize end-to-end", async () => {
    const q = new OperationQueue("sess-mut", { maxConcurrent: 1, maxReadonlyConcurrent: 4 });
    const t0 = Date.now();
    const results = await Promise.all([
      q.run("browser_navigate", () => okAfter(PER_CALL_MS), { lane: "mutating" }),
      q.run("browser_click", () => okAfter(PER_CALL_MS), { lane: "mutating" }),
      q.run("browser_navigate", () => okAfter(PER_CALL_MS), { lane: "mutating" }),
    ]);
    const elapsed = Date.now() - t0;
    assert.deepEqual(results, ["ok", "ok", "ok"]);
    assert.ok(
      elapsed >= 3 * PER_CALL_MS - SLACK_MS,
      `mutating lane must serialize (>= ${3 * PER_CALL_MS}ms), got ${elapsed}ms`,
    );
  });

  it("three read-only ops run in parallel — total ≈ 1 × perCall", async () => {
    const q = new OperationQueue("sess-ro", { maxConcurrent: 1, maxReadonlyConcurrent: 4 });
    const t0 = Date.now();
    const results = await Promise.all([
      q.run("browser_console", () => okAfter(PER_CALL_MS), { lane: "readonly" }),
      q.run("browser_network", () => okAfter(PER_CALL_MS), { lane: "readonly" }),
      q.run("browser_wait", () => okAfter(PER_CALL_MS), { lane: "readonly" }),
    ]);
    const elapsed = Date.now() - t0;
    assert.deepEqual(results, ["ok", "ok", "ok"]);
    assert.ok(
      elapsed < 2 * PER_CALL_MS,
      `read-only lane must parallelize (< ${2 * PER_CALL_MS}ms), got ${elapsed}ms`,
    );
    assert.ok(
      elapsed >= PER_CALL_MS - SLACK_MS,
      `parallel wall-clock floor (>= ${PER_CALL_MS}ms), got ${elapsed}ms`,
    );
  });

  it("read-only lane honors `maxReadonlyConcurrent` — caps at the configured width", async () => {
    const width = 2;
    const q = new OperationQueue("sess-cap", { maxConcurrent: 1, maxReadonlyConcurrent: width });
    const events: OperationEvent[] = [];
    q.onEvent = (ev) => events.push(ev);

    // Fire width+1 read-only ops. The first `width` should dispatch in
    // parallel; the (width+1)th must queue and dispatch after one frees.
    const N = width + 1;
    const t0 = Date.now();
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        q.run(`browser_console_${i}`, () => okAfter(PER_CALL_MS), { lane: "readonly" }),
      ),
    );
    const elapsed = Date.now() - t0;
    assert.deepEqual(results, Array.from({ length: N }, () => "ok"));
    assert.ok(
      elapsed >= 2 * PER_CALL_MS - SLACK_MS,
      `cap=${width} must force at least 2 batches (>= ${2 * PER_CALL_MS}ms), got ${elapsed}ms`,
    );
    assert.ok(
      elapsed < 3 * PER_CALL_MS,
      `cap=${width} must not force 3 batches (< ${3 * PER_CALL_MS}ms), got ${elapsed}ms`,
    );

    // Every started event must carry the lane discriminator.
    const started = events.filter((e) => e.kind === "started");
    assert.equal(started.length, N);
    for (const ev of started) {
      assert.equal((ev as { lane: string }).lane, "readonly");
    }
  });

  it("a queued read-only op waits behind an in-flight mutating op", async () => {
    const q = new OperationQueue("sess-mix", { maxConcurrent: 1, maxReadonlyConcurrent: 4 });
    const mut = deferredWork();
    const ro = deferredWork();

    // Start mutating; it's now in-flight.
    const mutPromise = q.run("browser_navigate", () => mut.promise, { lane: "mutating" });
    // Fire read-only — it must queue until mutating drains.
    const roPromise = q.run("browser_console", () => ro.promise, { lane: "readonly" });

    // Give the scheduler a tick to confirm read-only is queued.
    await sleep(20);
    assert.equal(q.stats().inFlight, 1, "mutating op should be in-flight");
    assert.equal(q.stats().queued, 1, "read-only op should be queued");

    // Drain mutating.
    mut.resolve();
    await mutPromise;
    // The read-only op can now start in parallel — release it.
    ro.resolve();
    const [mutRes, roRes] = await Promise.all([mutPromise, roPromise]);
    assert.equal(mutRes, "ok");
    assert.equal(roRes, "ok");
  });

  it("two sessions stay isolated: A's read-only pool does not affect B", async () => {
    const qa = new OperationQueue("sess-A", { maxConcurrent: 1, maxReadonlyConcurrent: 2 });
    const qb = new OperationQueue("sess-B", { maxConcurrent: 1, maxReadonlyConcurrent: 2 });

    // Saturate A's read-only pool with two long-running ops.
    const a1 = qa.run("browser_console", () => okAfter(PER_CALL_MS), { lane: "readonly" });
    const a2 = qa.run("browser_network", () => okAfter(PER_CALL_MS), { lane: "readonly" });
    // A's third readonly should queue.
    const a3Promise = qa.run("browser_wait", () => okAfter(PER_CALL_MS), { lane: "readonly" });
    await sleep(20);
    assert.equal(qa.stats().queued, 1, "A's 3rd readonly should be queued");

    // B can still dispatch a mutating op — its queue is independent.
    const t0 = Date.now();
    await qb.run("browser_navigate", () => okAfter(PER_CALL_MS), { lane: "mutating" });
    const bElapsed = Date.now() - t0;
    assert.ok(
      bElapsed >= PER_CALL_MS - SLACK_MS && bElapsed < 2 * PER_CALL_MS,
      `B's mutating op must dispatch on its own clock (${PER_CALL_MS}ms±slack), got ${bElapsed}ms`,
    );

    await Promise.all([a1, a2, a3Promise]);
  });

  it("default lane is `mutating` — backward compatibility preserved", async () => {
    const q = new OperationQueue("sess-default", { maxConcurrent: 1, maxReadonlyConcurrent: 4 });
    const events: OperationEvent[] = [];
    q.onEvent = (ev) => events.push(ev);
    await q.run("browser_click", () => sleep(40));
    const started = events.find((e) => e.kind === "started");
    assert.ok(started);
    assert.equal((started as { lane: string }).lane, "mutating");
  });

  it("overflow, cancel, and dispose behave the same on both lanes", async () => {
    // Overflow: tiny queueMax, saturate with read-only, third rejects.
    const qOver = new OperationQueue("sess-over", {
      maxConcurrent: 1,
      maxReadonlyConcurrent: 1,
      queueMax: 1,
    });
    const slow = deferredWork();
    const qOverPromise = qOver.run("browser_console", () => slow.promise, { lane: "readonly" });
    const qOverPromise2 = qOver.run("browser_network", () => sleep(200), { lane: "readonly" });
    await sleep(20);
    await assert.rejects(
      () => qOver.run("browser_wait", () => sleep(200), { lane: "readonly" }),
      (err: unknown) => err instanceof OperationQueueFullError && err.queueMax === 1,
    );
    slow.resolve();
    await Promise.all([qOverPromise, qOverPromise2]);

    // Cancel: pre-dispatch signal abort removes queued read-only.
    const qCancel = new OperationQueue("sess-cancel", {
      maxConcurrent: 1,
      maxReadonlyConcurrent: 2,
      waitTimeoutMs: 30_000,
    });
    const blocker = deferredWork();
    const blockerPromise = qCancel.run("browser_navigate", () => blocker.promise, {
      lane: "mutating",
    });
    await sleep(20);
    const ac = new AbortController();
    const cancelledPromise = qCancel.run("browser_console", () => sleep(200), {
      lane: "readonly",
      signal: ac.signal,
    });
    await sleep(10);
    ac.abort(new Error("client gave up"));
    await assert.rejects(
      () => cancelledPromise,
      (err: unknown) => err instanceof OperationCancelledError && err.code === "cancelled",
    );
    blocker.resolve();
    await blockerPromise;

    // Dispose: rejects every queued op in both lanes.
    const qDisp = new OperationQueue("sess-disp", {
      maxConcurrent: 1,
      maxReadonlyConcurrent: 2,
      waitTimeoutMs: 30_000,
    });
    const head = deferredWork();
    const headPromise = qDisp.run("browser_navigate", () => head.promise, { lane: "mutating" });
    const ro1 = qDisp.run("browser_console", () => sleep(200), { lane: "readonly" });
    const ro2 = qDisp.run("browser_network", () => sleep(200), { lane: "readonly" });
    await sleep(20);
    qDisp.dispose();
    head.resolve();
    await headPromise;
    await assert.rejects(
      () => ro1,
      (err: unknown) =>
        err instanceof OperationCancelledError && err.code === "session_disposed",
    );
    await assert.rejects(
      () => ro2,
      (err: unknown) =>
        err instanceof OperationCancelledError && err.code === "session_disposed",
    );
  });

  it("stats expose maxReadonlyConcurrent for /health consumers", () => {
    const q = new OperationQueue("sess-stats", { maxReadonlyConcurrent: 7 });
    assert.equal(q.stats().maxReadonlyConcurrent, 7);
    assert.equal(q.stats().maxConcurrent, 1); // mutating default
  });
});
