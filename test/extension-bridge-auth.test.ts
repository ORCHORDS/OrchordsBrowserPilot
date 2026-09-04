import assert from "node:assert/strict";
import test from "node:test";

import {
  attachBridgeAuth,
  signBridgeEnvelope as signBrowserEnvelope,
  verifyBridgeEnvelopeAuth as verifyBrowserEnvelopeAuth,
} from "../extension/bridge-auth.js";
import {
  createPairing,
  signBridgeEnvelopeWithRecord,
  verifyBridgeEnvelopeAuth,
} from "../src/native-pairing.js";

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
  const auth = await signBrowserEnvelope(credential, envelope);
  assert.match(auth.mac, /^[a-f0-9]{64}$/);
  assert.equal(verifyBridgeEnvelopeAuth(record, envelope, auth, binding), true);
});

test("host verifier HMAC verifies in browser Web Crypto for authenticated responses (#123)", async () => {
  const { credential, record } = createPairing({
    ...binding,
    now: () => 1_000,
    randomUUID: () => "pair-2",
    randomBytes: (size: number) => Buffer.alloc(size, 0x44),
  });
  const envelope = {
    protocol: 1,
    id: "response-1",
    nonce: "nonce-response-1",
    deadlineAt: 2_000,
    type: "bridge.response",
    payload: { ok: true },
  };
  const auth = signBridgeEnvelopeWithRecord(record, envelope);
  assert.equal(await verifyBrowserEnvelopeAuth(credential, envelope, auth), true);
  assert.equal(
    await verifyBrowserEnvelopeAuth(credential, { ...envelope, payload: { ok: false } }, auth),
    false,
  );
});

test("attached auth covers the immutable envelope and fails after payload tampering (#123)", async () => {
  const { credential, record } = createPairing({
    ...binding,
    now: () => 1_000,
    randomUUID: () => "pair-3",
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
