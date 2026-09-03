import assert from "node:assert/strict";
import test from "node:test";

import {
  createPairing,
  revokePairing,
  rotatePairing,
  signBridgeEnvelope,
  verifyBridgeEnvelopeAuth,
} from "../src/native-pairing.js";

const fixedRandom = (size: number) => Buffer.alloc(size, 0x2a);
const base = {
  callerOrigin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/",
  installId: "install-a",
  profileId: "profile-a",
  now: () => 1_000,
  randomBytes: fixedRandom,
};

test("pairing is bound to extension origin, install, and local profile and stores no plaintext secret (#123)", () => {
  const { credential, record } = createPairing(base);
  assert.equal(record.callerOrigin, base.callerOrigin);
  assert.equal(record.installId, base.installId);
  assert.equal(record.profileId, base.profileId);
  assert.equal(record.status, "active");
  assert.equal("secret" in record, false);
  assert.match(record.secretHash, /^[a-f0-9]{64}$/);
  assert.equal(credential.pairingId, record.pairingId);
  assert.match(credential.secret, /^[A-Za-z0-9_-]{43}$/);
});

test("signed envelopes authenticate only for the bound active pairing (#123)", () => {
  const { credential, record } = createPairing(base);
  const envelope = {
    protocol: 1,
    id: "req-1",
    nonce: "nonce-1",
    deadlineAt: 2_000,
    type: "bridge.request",
    payload: { tool: "browser_snapshot" },
  };
  const auth = signBridgeEnvelope(credential, envelope);
  const binding = {
    callerOrigin: base.callerOrigin,
    installId: base.installId,
    profileId: base.profileId,
  };
  assert.equal(verifyBridgeEnvelopeAuth(record, envelope, auth, binding), true);
  assert.equal(verifyBridgeEnvelopeAuth(record, { ...envelope, nonce: "tampered" }, auth, binding), false);
  assert.equal(verifyBridgeEnvelopeAuth(record, envelope, auth, { ...binding, installId: "other-install" }), false);
});

test("rotation invalidates the old secret and revocation blocks the new secret (#123)", () => {
  const first = createPairing(base);
  let counter = 0;
  const rotated = rotatePairing(first.record, {
    now: () => 2_000,
    randomBytes: (size: number) => Buffer.alloc(size, ++counter),
  });
  const envelope = {
    protocol: 1,
    id: "req-2",
    nonce: "nonce-2",
    deadlineAt: 3_000,
    type: "bridge.request",
    payload: {},
  };
  const oldAuth = signBridgeEnvelope(first.credential, envelope);
  const newAuth = signBridgeEnvelope(rotated.credential, envelope);
  const binding = {
    callerOrigin: base.callerOrigin,
    installId: base.installId,
    profileId: base.profileId,
  };
  assert.equal(verifyBridgeEnvelopeAuth(rotated.record, envelope, oldAuth, binding), false);
  assert.equal(verifyBridgeEnvelopeAuth(rotated.record, envelope, newAuth, binding), true);
  const revoked = revokePairing(rotated.record, 2_500);
  assert.equal(verifyBridgeEnvelopeAuth(revoked, envelope, newAuth, binding), false);
});
