import assert from "node:assert/strict";
import test from "node:test";

import {
  ENVELOPE_CANCEL_TYPE,
  ENVELOPE_CANCEL_VERSION,
  ENVELOPE_PROTOCOL_FEATURES,
  createEnvelopeCancellation,
  negotiateEnvelopeCompatibility,
} from "../extension/envelope-cancellation.js";

test("cancellation records and notifies observers (#133)", () => {
  const events = [];
  const cancel = createEnvelopeCancellation({ now: () => 1_000 });
  const off = cancel.observe((e) => events.push(e));
  const record = cancel.cancel({ envelopeId: "abc", reason: "user-cancelled" });
  assert.equal(record.version, ENVELOPE_CANCEL_VERSION);
  assert.equal(record.envelopeId, "abc");
  assert.equal(record.cancelledAt, 1_000);
  assert.equal(cancel.isCancelled("abc"), true);
  assert.equal(cancel.reason("abc"), "user-cancelled");
  off();
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "cancelled");
});

test("acknowledge removes the cancellation record (#133)", () => {
  const cancel = createEnvelopeCancellation();
  cancel.cancel({ envelopeId: "x" });
  assert.equal(cancel.isCancelled("x"), true);
  const acked = cancel.acknowledge("x");
  assert.equal(acked?.envelopeId, "x");
  assert.equal(cancel.isCancelled("x"), false);
  assert.equal(cancel.acknowledge("x"), null);
});

test("cancel throws on missing envelopeId (#133)", () => {
  const cancel = createEnvelopeCancellation();
  assert.throws(() => cancel.cancel({}), /requires an envelopeId/);
  assert.throws(() => cancel.cancel({ envelopeId: "" }), /requires an envelopeId/);
});

test("cancellation snapshot returns the live records (#133)", () => {
  const cancel = createEnvelopeCancellation();
  cancel.cancel({ envelopeId: "a", reason: "r1" });
  cancel.cancel({ envelopeId: "b", reason: "r2" });
  const snap = cancel.snapshot();
  assert.equal(snap.length, 2);
  assert.ok(snap.find((r) => r.envelopeId === "a" && r.reason === "r1"));
});

test("negotiation table is frozen and exposes the envelope types (#133)", () => {
  assert.equal(Object.isFrozen(ENVELOPE_PROTOCOL_FEATURES), true);
  assert.equal(ENVELOPE_PROTOCOL_FEATURES.supports.includes(ENVELOPE_CANCEL_TYPE), true);
});

test("negotiation succeeds when both sides share at least one envelope type (#133)", () => {
  const result = negotiateEnvelopeCompatibility({
    peerFeatures: {
      coreVersion: "0.1.0",
      extensionVersion: "0.1.0",
      supports: ["bridge.hello", "bridge.response"],
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.shared, ["bridge.hello", "bridge.response"]);
});

test("negotiation fails when no envelope types are shared (#133)", () => {
  const result = negotiateEnvelopeCompatibility({
    peerFeatures: {
      coreVersion: "0.1.0",
      extensionVersion: "0.1.0",
      supports: ["some.future.type"],
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "no_shared_envelope_types");
});

test("negotiation fails when peerFeatures are malformed (#133)", () => {
  assert.equal(negotiateEnvelopeCompatibility({ peerFeatures: null }).ok, false);
  assert.equal(
    negotiateEnvelopeCompatibility({
      peerFeatures: { coreVersion: "0.1.0", extensionVersion: "0.1.0", supports: [] },
    }).code,
    "no_supported_envelopes",
  );
  assert.equal(
    negotiateEnvelopeCompatibility({
      peerFeatures: { supports: ["bridge.hello"] },
    }).code,
    "missing_versions",
  );
});
