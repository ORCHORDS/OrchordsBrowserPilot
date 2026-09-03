import assert from "node:assert/strict";
import test from "node:test";

import { validateAuthenticatedBridgeMessage } from "../src/native-bridge-auth.js";
import { createPairing, signBridgeEnvelope } from "../src/native-pairing.js";

const binding = {
  callerOrigin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
  installId: "a".repeat(64),
  profileId: "profile-a",
};

function fixture() {
  const { credential, record } = createPairing({
    ...binding,
    now: () => 1_000,
    randomUUID: () => "pair-1",
    randomBytes: (size: number) => Buffer.alloc(size, 0x2a),
  });
  const envelope = {
    protocol: 1 as const,
    id: "11111111-1111-4111-8111-111111111111",
    nonce: "b".repeat(64),
    deadlineAt: 2_000,
    type: "bridge.request" as const,
    payload: { tool: "browser_snapshot", arguments: {} },
  };
  return { credential, record, envelope };
}

test("authenticated bridge request validates HMAC, binding, and returns a replay key (#123)", () => {
  const { credential, record, envelope } = fixture();
  const message = { ...envelope, auth: signBridgeEnvelope(credential, envelope) };
  const result = validateAuthenticatedBridgeMessage(message, {
    record,
    binding,
    replayKeys: new Set(),
    now: () => 1_000,
  });
  assert.equal(result.replayKey, `${envelope.id}:${envelope.nonce}`);
  assert.deepEqual(result.envelope, envelope);
});

test("authenticated bridge request rejects tampering, stale generation, replay, and expiry (#123)", () => {
  const { credential, record, envelope } = fixture();
  const auth = signBridgeEnvelope(credential, envelope);
  assert.throws(
    () =>
      validateAuthenticatedBridgeMessage(
        { ...envelope, payload: { tool: "browser_evaluate", arguments: {} }, auth },
        { record, binding, replayKeys: new Set(), now: () => 1_000 },
      ),
    /authentication failed/i,
  );
  assert.throws(
    () =>
      validateAuthenticatedBridgeMessage(
        { ...envelope, auth: { ...auth, generation: auth.generation + 1 } },
        { record, binding, replayKeys: new Set(), now: () => 1_000 },
      ),
    /authentication failed/i,
  );
  assert.throws(
    () =>
      validateAuthenticatedBridgeMessage(
        { ...envelope, auth },
        { record, binding, replayKeys: new Set([`${envelope.id}:${envelope.nonce}`]), now: () => 1_000 },
      ),
    /replay/i,
  );
  assert.throws(
    () =>
      validateAuthenticatedBridgeMessage(
        { ...envelope, auth },
        { record, binding, replayKeys: new Set(), now: () => 2_001 },
      ),
    /expired/i,
  );
});
