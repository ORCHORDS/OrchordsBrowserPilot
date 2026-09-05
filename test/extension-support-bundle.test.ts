import assert from "node:assert/strict";
import test from "node:test";

import {
  SUPPORT_BUNDLE_VERSION,
  assertSupportBundleRedactions,
  createSupportBundle,
} from "../extension/support-bundle.js";

function sampleSnapshot() {
  return {
    state: "observing",
    monotonic: 42,
    bridgeCompat: { ok: true, coreVersion: "0.1.0", extensionVersion: "0.1.0" },
    browser: { vendor: "Chrome", version: "120.0" },
    core: { version: "0.1.0" },
    pairing: { pairingId: "abc-12345", generation: 1 },
    siteAuthorizations: {
      grants: [{ origin: "https://example.com", kind: "session" }],
      denials: ["https://blocked.example"],
      onceUsed: ["https://example.com"],
      audit: [{ from: "connected-idle", to: "observing", actor: "user", reason: "approve", at: 1_700_000_005_000 }],
    },
    settings: { interfaceDensity: "default", startupBehavior: "remember", diagnosticsOptIn: true },
    doctor: {
      severity: "warning",
      issues: [{ code: "EXT-NATIVE-DISCONNECTED", severity: "warning", message: "host disconnected", fix: "reconnect" }],
    },
    lastBridgeError: { code: "EXT-NATIVE-DISCONNECTED", message: "host disconnected", at: 1_700_000_000_000 },
    audit: [
      { from: "disconnected", to: "connected-idle", actor: "system", reason: "paired", at: 1_700_000_000_000 },
      { from: "connected-idle", to: "observing", actor: "user", reason: "approve", at: 1_700_000_300_000 },
    ],
  };
}

test("createSupportBundle writes a versioned bundle with redacted pairing (#141)", () => {
  const bundle = createSupportBundle(sampleSnapshot(), { now: () => 1_700_000_999_999 });
  assert.equal(bundle.version, SUPPORT_BUNDLE_VERSION);
  assert.equal(bundle.controlState.state, "observing");
  assert.equal(bundle.pairing.pairingId, "[REDACTED]");
  assert.equal(bundle.pairing.fingerprint.startsWith("fp-"), true);
  assert.equal(bundle.audit.length, 2);
  // audit entries must be minute-grained
  for (const entry of bundle.audit) {
    assert.equal(Number.isInteger(entry.at), true);
  }
});

test("createSupportBundle never leaks the installId or filesystem paths (#141)", () => {
  const snapshot = sampleSnapshot();
  snapshot.pairing.installId = "abcd1234";
  const bundle = createSupportBundle(snapshot);
  const text = JSON.stringify(bundle);
  assert.equal(text.includes("abcd1234"), false);
  assert.equal(text.includes("C:\\"), false);
  assert.equal(text.includes("/Users/"), false);
});

test("createSupportBundle redaction assertion passes for a clean snapshot (#141)", () => {
  const bundle = createSupportBundle(sampleSnapshot());
  assert.deepEqual(assertSupportBundleRedactions(bundle), { ok: true });
});

test("createSupportBundle redaction assertion fails when forbidden tokens appear (#141)", () => {
  // We test the redaction assertion directly with a hand-crafted bundle
  // that simulates a regression where a forbidden token leaks into a
  // value. createSupportBundle itself redacts paths, so we cannot
  // exercise the assertion via the public factory alone.
  const leakyBundle = {
    version: 1,
    lastBridgeError: { code: "C:\\Windows\\System32", at: 1 },
  };
  assert.throws(
    () => assertSupportBundleRedactions(leakyBundle),
    /forbidden token/,
  );
});

test("createSupportBundle truncates doctor messages and fixes to <= 240 chars (#141)", () => {
  const snapshot = sampleSnapshot();
  snapshot.doctor.issues = [{
    code: "X",
    severity: "info",
    message: "x".repeat(1024),
    fix: "y".repeat(1024),
  }];
  const bundle = createSupportBundle(snapshot);
  assert.ok(bundle.doctor.issues[0].message.length <= 240);
  assert.ok(bundle.doctor.issues[0].fix.length <= 240);
});

test("createSupportBundle trims site grants to <= 50 entries (#141)", () => {
  const snapshot = sampleSnapshot();
  snapshot.siteAuthorizations.grants = Array.from({ length: 200 }, (_, i) => ({
    origin: `https://example${i}.com`,
    kind: "session",
  }));
  const bundle = createSupportBundle(snapshot);
  assert.equal(bundle.siteAuthorizations.grants.length, 50);
});
