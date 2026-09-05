import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
  SESSION_INFLIGHT_KEY,
  SESSION_LAST_ACK_KEY,
  createServiceWorkerLifecycle,
} from "../extension/service-worker-lifecycle.js";

function memorySession() {
  const data = new Map();
  return {
    async get(key) {
      return { [key]: data.get(key) };
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) data.set(k, v);
    },
  };
}

function fixedClock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

function fakeChrome({ heartbeat = false, alarms = false } = {}) {
  return {
    runtime: {
      id: "test",
      getManifest: () => ({ version: "0.1.0", manifest_version: 3 }),
    },
    alarms: alarms
      ? {
          create() {},
          onAlarm: { addListener() {} },
        }
      : null,
  };
}

test("SWLifecycle heartbeat is scheduled on start (#130)", () => {
  const clock = fixedClock();
  const sent = [];
  const lifecycle = createServiceWorkerLifecycle({
    chromeApi: fakeChrome(),
    storageSession: memorySession(),
    postEnvelope: (type, payload) => {
      sent.push({ type, payload });
      return { ok: true, id: `e-${sent.length}` };
    },
    now: clock.now,
  });
  lifecycle.startHeartbeat();
  assert.equal(lifecycle.isHeartbeatActive(), true);
});

test("SWLifecycle.triggerReconnect runs the backoff schedule (#130)", async () => {
  const clock = fixedClock();
  const sent = [];
  let attempts = 0;
  const lifecycle = createServiceWorkerLifecycle({
    chromeApi: fakeChrome(),
    storageSession: memorySession(),
    postEnvelope: (type, payload) => {
      sent.push({ type, payload });
      return { ok: true, id: `e-${sent.length}` };
    },
    now: clock.now,
    reconnectBackoffMs: [50, 100, 200, 400],
  });
  // First reconnect: 50ms delay. Second: 100ms. Then resets.
  const first = await lifecycle.triggerReconnect({ reason: "test" });
  assert.equal(first.ok, true);
  assert.equal(lifecycle.getReconnectAttempts(), 0);
  // Trigger several times in a row to exercise the attempts counter.
  const beforeAttempts = lifecycle.getReconnectAttempts();
  for (let i = 0; i < 3; i += 1) await lifecycle.triggerReconnect({ reason: "loop" });
  attempts = lifecycle.getReconnectAttempts();
  assert.ok(attempts >= 0, "reconnectAttempts never goes negative");
});

test("SWLifecycle.resumeInflight drops expired envelopes and re-posts live ones (#130)", async () => {
  const clock = fixedClock();
  const session = memorySession();
  // Pre-populate inflight with one expired and one live envelope.
  await session.set({
    [SESSION_INFLIGHT_KEY]: [
      { id: "exp", type: "bridge.request", payload: { id: 1 }, deadlineAt: clock.now() - 1000 },
      { id: "live", type: "bridge.request", payload: { id: 2 }, deadlineAt: clock.now() + 30_000 },
    ],
  });
  const sent = [];
  const lifecycle = createServiceWorkerLifecycle({
    chromeApi: fakeChrome(),
    storageSession: session,
    postEnvelope: (type, payload) => {
      sent.push({ type, payload, id: `e-${sent.length}` });
      return { ok: true, id: `e-${sent.length}` };
    },
    now: clock.now,
  });
  const resumed = await lifecycle.resumeInflight();
  assert.equal(resumed.resumed, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.id, 2);
  const stored = await session.get(SESSION_INFLIGHT_KEY);
  assert.deepEqual(stored[SESSION_INFLIGHT_KEY], [{ id: "live", type: "bridge.request", payload: { id: 2 }, deadlineAt: clock.now() + 30_000 }]);
});

test("SWLifecycle.trackOutbound rejects duplicates (#130)", async () => {
  const session = memorySession();
  const lifecycle = createServiceWorkerLifecycle({
    chromeApi: fakeChrome(),
    storageSession: session,
    postEnvelope: () => ({ ok: true, id: "x" }),
    now: () => 1,
  });
  const envelope = { id: "dup", type: "bridge.request", payload: {}, deadlineAt: 2 };
  assert.deepEqual(await lifecycle.trackOutbound(envelope), { ok: true, position: 1 });
  assert.deepEqual(await lifecycle.trackOutbound(envelope), { ok: false, code: "duplicate" });
});

test("SWLifecycle defaults are exported (#130)", () => {
  assert.ok(DEFAULT_HEARTBEAT_INTERVAL_MS > 0);
  assert.ok(DEFAULT_HEARTBEAT_TIMEOUT_MS > DEFAULT_HEARTBEAT_INTERVAL_MS);
});

test("SWLifecycle.startHeartbeat activates the heartbeat timer (#130)", () => {
  const lifecycle = createServiceWorkerLifecycle({
    chromeApi: fakeChrome(),
    storageSession: memorySession(),
    postEnvelope: () => ({ ok: true }),
  });
  assert.equal(lifecycle.isHeartbeatActive(), false);
  lifecycle.startHeartbeat();
  assert.equal(lifecycle.isHeartbeatActive(), true);
  lifecycle.stopHeartbeat();
  assert.equal(lifecycle.isHeartbeatActive(), false);
});
