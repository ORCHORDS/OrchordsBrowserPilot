import assert from "node:assert/strict";
import test from "node:test";

import { createShutdownController } from "../src/shutdown.js";

interface RecordedEvent {
  kind: string;
  trigger?: string;
  name?: string;
  ms?: number;
  error?: string;
}

function captureSink() {
  const events: RecordedEvent[] = [];
  return {
    events,
    sink: (e: RecordedEvent): void => { events.push(e); },
  };
}

test("shutdown controller: is idempotent under repeated triggers", async () => {
  const sinks = captureSink();
  const ctrl = createShutdownController({ graceMs: 100, forceExitAfterMs: 200, onLifecycle: sinks.sink });
  let runs = 0;
  ctrl.addCleanup({ name: "first", run: () => { runs += 1; } });

  await ctrl.trigger("explicit");
  await ctrl.trigger("explicit");
  await ctrl.trigger("sigterm");

  assert.equal(runs, 1, "hook must run exactly once for multiple triggers");
  assert.equal(ctrl.isDraining(), true);
  assert.ok(sinks.events.some((e) => e.kind === "draining"), "must emit draining");
  assert.ok(sinks.events.some((e) => e.kind === "stopped"), "must emit stopped");
});

test("shutdown controller: runs hooks in registration order", async () => {
  const order: string[] = [];
  const ctrl = createShutdownController({ graceMs: 200, forceExitAfterMs: 1000 });
  ctrl.addCleanup({ name: "a", run: async () => { order.push("a"); } });
  ctrl.addCleanup({ name: "b", run: async () => { order.push("b"); } });
  ctrl.addCleanup({ name: "c", run: async () => { order.push("c"); } });

  await ctrl.trigger("sigterm");
  assert.deepEqual(order, ["a", "b", "c"]);
});

test("shutdown controller: hook failures do not stop later hooks", async () => {
  const sinks = captureSink();
  const ctrl = createShutdownController({
    graceMs: 200,
    forceExitAfterMs: 1000,
    onLifecycle: sinks.sink,
  });
  let cRan = false;
  ctrl.addCleanup({ name: "throws", run: () => { throw new Error("boom"); } });
  ctrl.addCleanup({ name: "c", run: () => { cRan = true; } });

  await ctrl.trigger("explicit");
  assert.equal(cRan, true, "later hook must run even if earlier hook throws");
  const failed = sinks.events.find((e) => e.kind === "cleanup-failed" && e.name === "throws");
  assert.ok(failed, "must emit cleanup-failed with the failing hook's name");
  assert.match(failed?.error ?? "", /boom/);
});

test("shutdown controller: hook exceeding its timeout is recorded and bounded", async () => {
  const sinks = captureSink();
  const ctrl = createShutdownController({
    graceMs: 50,
    forceExitAfterMs: 5000,
    onLifecycle: sinks.sink,
  });
  ctrl.addCleanup({
    name: "slow",
    run: () => new Promise<void>((resolve) => setTimeout(resolve, 200)),
    timeoutMs: 50,
  });
  let laterRan = false;
  ctrl.addCleanup({ name: "later", run: () => { laterRan = true; } });

  await ctrl.trigger("explicit");
  assert.equal(laterRan, true, "later hook must still run");
  assert.ok(
    sinks.events.some((e) => e.kind === "cleanup-failed" && e.name === "slow"),
    "slow hook must be reported as failed with its name",
  );
});

test("shutdown controller: whenDone resolves after trigger completes", async () => {
  const ctrl = createShutdownController({ graceMs: 100, forceExitAfterMs: 1000 });
  ctrl.addCleanup({ name: "ok", run: () => undefined });
  const pending = ctrl.whenDone();
  const triggerP = ctrl.trigger("sigterm");
  await Promise.all([pending, triggerP]);
  // Now isDraining must hold.
  assert.equal(ctrl.isDraining(), true);
});

test("shutdown controller: whenDone resolves immediately when no trigger has fired", async () => {
  const ctrl = createShutdownController({ graceMs: 100, forceExitAfterMs: 1000 });
  await ctrl.whenDone();
  assert.equal(ctrl.isDraining(), false);
});

test("shutdown controller: per-hook timeoutMs is clamped under the force-exit deadline", async () => {
  const sinks = captureSink();
  const ctrl = createShutdownController({
    graceMs: 100,
    forceExitAfterMs: 200, // window is small on purpose
    onLifecycle: sinks.sink,
  });
  // Asking for 100 minutes must be silently clamped so a misconfigured
  // caller cannot push the watchdog out of reach.
  ctrl.addCleanup({
    name: "shouty",
    run: () => undefined,
    timeoutMs: 10 * 60 * 1000,
  });
  await ctrl.trigger("explicit");
  assert.ok(
    sinks.events.some((e) => e.kind === "cleanup-finished" && e.name === "shouty"),
    "clamped hook still runs",
  );
});

test("shutdown controller: addCleanup returns an unsubscribe function", async () => {
  const ctrl = createShutdownController({ graceMs: 100, forceExitAfterMs: 1000 });
  let runCount = 0;
  const unsub = ctrl.addCleanup({ name: "x", run: () => { runCount += 1; } });
  assert.deepEqual(ctrl.hookNames(), ["x"]);
  unsub();
  assert.deepEqual(ctrl.hookNames(), []);
  await ctrl.trigger("explicit");
  assert.equal(runCount, 0, "removed hook must not run");
});

test("shutdown controller: addCleanup rejects non-function run()", () => {
  const ctrl = createShutdownController({ graceMs: 50, forceExitAfterMs: 200 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.throws(() => ctrl.addCleanup({ name: "bad", run: undefined as any }));
});

test("shutdown controller: emits grace-exceeded when total elapsed > graceMs", async () => {
  const sinks = captureSink();
  const graceMs = 30;
  const ctrl = createShutdownController({
    graceMs,
    forceExitAfterMs: 1000,
    onLifecycle: sinks.sink,
  });
  ctrl.addCleanup({
    name: "past-grace",
    run: () => new Promise<void>((resolve) => setTimeout(resolve, 80)),
    // The default hook timeout equals graceMs. Give this fixture a later
    // hook deadline so cleanup actually runs beyond the total grace budget
    // instead of racing the exact grace/timeout boundary.
    timeoutMs: 120,
  });
  await ctrl.trigger("explicit");
  const exceeded = sinks.events.find((e) => e.kind === "grace-exceeded");
  assert.ok(exceeded, "must report grace-exceeded when cleanup runs past graceMs");
  assert.ok((exceeded.ms ?? 0) > graceMs, "grace-exceeded must carry an elapsed time beyond graceMs");
});

test("shutdown controller: does not emit grace-exceeded within graceMs", async () => {
  const sinks = captureSink();
  const ctrl = createShutdownController({
    graceMs: 100,
    forceExitAfterMs: 1000,
    onLifecycle: sinks.sink,
  });
  ctrl.addCleanup({ name: "fast", run: () => undefined });
  await ctrl.trigger("explicit");
  assert.equal(
    sinks.events.some((e) => e.kind === "grace-exceeded"),
    false,
    "must not report grace-exceeded for cleanup that stays within graceMs",
  );
});

test("shutdown controller: emit() failures inside the sink never abort cleanup", async () => {
  const ctrl = createShutdownController({
    graceMs: 50,
    forceExitAfterMs: 1000,
    onLifecycle: () => { throw new Error("sink exploded"); },
  });
  let ran = false;
  ctrl.addCleanup({ name: "ok", run: () => { ran = true; } });
  await ctrl.trigger("explicit");
  assert.equal(ran, true, "cleanup must continue even if the lifecycle sink throws");
});
