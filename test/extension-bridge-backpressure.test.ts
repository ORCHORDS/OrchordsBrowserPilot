import assert from "node:assert/strict";
import test from "node:test";

import {
  BridgeOutboundQueue,
  DEFAULT_BRIDGE_OUTBOUND_LIMIT,
  createBridgeEnvelope,
} from "../extension/bridge-protocol.js";

function fixedNow() {
  let t = 1_700_000_000_000;
  return () => (t += 1);
}

test("BridgeOutboundQueue enforces its bounded capacity (#123)", () => {
  const queue = new BridgeOutboundQueue({ limit: 3 });
  assert.equal(queue.capacity(), 3);
  const env1 = createBridgeEnvelope("bridge.request", { id: 1 }, { now: fixedNow() });
  const env2 = createBridgeEnvelope("bridge.request", { id: 2 }, { now: fixedNow() });
  const env3 = createBridgeEnvelope("bridge.request", { id: 3 }, { now: fixedNow() });
  const env4 = createBridgeEnvelope("bridge.request", { id: 4 }, { now: fixedNow() });

  assert.deepEqual(queue.enqueue(env1), { ok: true, position: 1 });
  assert.deepEqual(queue.enqueue(env2), { ok: true, position: 2 });
  assert.deepEqual(queue.enqueue(env3), { ok: true, position: 3 });
  assert.deepEqual(queue.enqueue(env4), { ok: false, code: "backpressure", capacity: 3 });
  assert.equal(queue.size(), 3);
});

test("BridgeOutboundQueue rejects non-objects (#123)", () => {
  const queue = new BridgeOutboundQueue({ limit: 2 });
  assert.deepEqual(queue.enqueue(null), { ok: false, code: "malformed_envelope" });
  assert.equal(queue.size(), 0);
});

test("BridgeOutboundQueue drains in FIFO order (#123)", () => {
  const queue = new BridgeOutboundQueue({ limit: 2 });
  const env1 = createBridgeEnvelope("bridge.request", { id: 1 }, { now: fixedNow() });
  const env2 = createBridgeEnvelope("bridge.request", { id: 2 }, { now: fixedNow() });
  queue.enqueue(env1);
  queue.enqueue(env2);
  assert.equal(queue.drainOne(), env1);
  assert.equal(queue.drainOne(), env2);
  assert.equal(queue.drainOne(), null);
});

test("BridgeOutboundQueue.drainAll returns a copy and empties the queue (#123)", () => {
  const queue = new BridgeOutboundQueue({ limit: 4 });
  queue.enqueue(createBridgeEnvelope("bridge.request", { id: 1 }, { now: fixedNow() }));
  queue.enqueue(createBridgeEnvelope("bridge.request", { id: 2 }, { now: fixedNow() }));
  const drained = queue.drainAll();
  assert.equal(drained.length, 2);
  assert.equal(queue.size(), 0);
  // draining a second time is a no-op
  assert.equal(queue.drainAll().length, 0);
});

test("BridgeOutboundQueue drops expired envelopes and reports the count (#123)", () => {
  let t = 0;
  const now = () => t;
  // Build two expired envelopes (deadline 100, created at t=0) and one live
  // envelope (deadline 300, created at t=100). TTL is the default 30s; we
  // set the envelopes' deadlineAt manually to keep the test deterministic.
  const exp1 = createBridgeEnvelope("bridge.request", { id: 1 }, { now: () => 0, ttlMs: 100 });
  const exp2 = createBridgeEnvelope("bridge.request", { id: 2 }, { now: () => 0, ttlMs: 100 });
  const live = createBridgeEnvelope("bridge.request", { id: 3 }, { now: () => 100, ttlMs: 200 });
  const queue = new BridgeOutboundQueue({ limit: 4 });
  queue.enqueue(exp1);
  queue.enqueue(exp2);
  queue.enqueue(live);
  t = 200;
  const result = queue.rejectIfExpired({ now });
  assert.equal(result.expired, 2);
  assert.equal(result.retained, 1);
  assert.equal(queue.size(), 1);
  assert.equal(queue.drainOne(), live);
});

test("BridgeOutboundQueue default limit is exported and finite (#123)", () => {
  assert.ok(Number.isInteger(DEFAULT_BRIDGE_OUTBOUND_LIMIT));
  assert.ok(DEFAULT_BRIDGE_OUTBOUND_LIMIT > 0);
  const queue = new BridgeOutboundQueue();
  assert.equal(queue.capacity(), DEFAULT_BRIDGE_OUTBOUND_LIMIT);
});
