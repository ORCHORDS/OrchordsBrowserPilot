import assert from "node:assert/strict";
import test from "node:test";

import {
  BRIDGE_PROTOCOL_VERSION,
  MAX_BRIDGE_MESSAGE_BYTES,
  ReplayWindow,
  createBridgeEnvelope,
  validateBridgeEnvelope,
} from "../extension/bridge-protocol.js";

const now = 1_800_000_000_000;
const uuid = "11111111-1111-4111-8111-111111111111";
const nonce = "a".repeat(43);

test("bridge protocol creates a bounded v1 envelope with id, nonce, and deadline (#123)", () => {
  const envelope = createBridgeEnvelope("bridge.hello", { extensionId: "abc" }, {
    now: () => now,
    randomUUID: () => uuid,
    randomNonce: () => nonce,
    ttlMs: 30_000,
  });

  assert.equal(envelope.protocol, BRIDGE_PROTOCOL_VERSION);
  assert.equal(envelope.id, uuid);
  assert.equal(envelope.nonce, nonce);
  assert.equal(envelope.deadlineAt, now + 30_000);
  assert.deepEqual(envelope.payload, { extensionId: "abc" });
});

test("bridge protocol rejects version drift, expiry, replay, and oversized envelopes (#123)", () => {
  const base = createBridgeEnvelope("bridge.ready", {}, {
    now: () => now,
    randomUUID: () => uuid,
    randomNonce: () => nonce,
    ttlMs: 30_000,
  });
  const replay = new ReplayWindow();

  assert.deepEqual(validateBridgeEnvelope(base, { now: () => now, replay }), { ok: true });
  replay.add(base);
  assert.equal(validateBridgeEnvelope(base, { now: () => now, replay }).code, "replay");
  assert.equal(
    validateBridgeEnvelope({ ...base, protocol: 2 }, { now: () => now, replay: new ReplayWindow() }).code,
    "protocol",
  );
  assert.equal(
    validateBridgeEnvelope({ ...base, deadlineAt: now - 1 }, { now: () => now, replay: new ReplayWindow() }).code,
    "expired",
  );
  const huge = {
    ...base,
    id: "22222222-2222-4222-8222-222222222222",
    nonce: "b".repeat(43),
    payload: { data: "x".repeat(MAX_BRIDGE_MESSAGE_BYTES) },
  };
  assert.equal(validateBridgeEnvelope(huge, { now: () => now, replay: new ReplayWindow() }).code, "too_large");
});

test("bridge replay window survives hydration and stays bounded (#123)", () => {
  const hydrated = new ReplayWindow(["old-key"], 2);
  assert.equal(hydrated.hasKey("old-key"), true);
  hydrated.addKey("new-1");
  hydrated.addKey("new-2");
  assert.deepEqual(hydrated.toJSON(), ["new-1", "new-2"]);
});
