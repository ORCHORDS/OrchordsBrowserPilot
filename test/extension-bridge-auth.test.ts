import assert from "node:assert/strict";
import test from "node:test";

import { attachBridgeAuth, signBridgeEnvelope } from "../extension/bridge-auth.js";
import { createPairing, verifyBridgeEnvelopeAuth } from "../src/native-pairing.js";

const binding = {
  callerOrigin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
  installId: "a".repeat(64),
  profileId: "profile-a",
};

test("browser Web Crypto HMAC verifies against the Node native-host pairing record (#123)", async () => {
  const { credential, record } = createPairing({
    ...binding,
    now: () => 1_000,
    randomUUID: () => "pair-1",
    randomBytes: (size: number) => Buffer.alloc(size, 0x2a),
  });
  const envelope = {
    protocol: 1,
    id: "request-1",
    nonce: "nonce-1",
    deadlineAt: 2_000,
    type: "bridge.request",
    payload: { arguments: { ref: "e12", text: "hello" }, tool: "browser_type" },
  };
  const auth = await signBridgeEnvelope(credential, envelope);
  assert.match(auth.mac, /^[a-f0-9]{64}$/);
  assert.equal(verifyBridgeEnvelopeAuth(record, envelope, auth, binding), true);
});

test("attached auth covers the immutable envelope and fails after payload tampering (#123)", async () => {
  const { credential, record } = createPairing({
    ...binding,
    now: () => 1_000,
    randomUUID: () => "pair-2",
    randomBytes: (size: number) => Buffer.alloc(size, 0x33),
  });
  const envelope = {
    protocol: 1,
    id: "request-2",
    nonce: "nonce-2",
    deadlineAt: 2_000,
    type: "bridge.request",
    payload: { tool: "browser_snapshot", arguments: {} },
  };
  const authenticated = await attachBridgeAuth(credential, envelope);
  const { auth, ...signedEnvelope } = authenticated;
  assert.equal(verifyBridgeEnvelopeAuth(record, signedEnvelope, auth, binding), true);
  assert.equal(
    verifyBridgeEnvelopeAuth(
      record,
      { ...signedEnvelope, payload: { tool: "browser_evaluate", arguments: { expression: "1+1" } } },
      auth,
      binding,
    ),
    false,
  );
});
