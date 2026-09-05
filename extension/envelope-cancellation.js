// Envelope cancellation + compat negotiation (#133).
//
// Native-messaging envelopes are request/response pairs identified by
// `envelope.id`. The host may take seconds to answer; users (and the
// service worker) need a way to cancel an in-flight envelope without
// losing the ability to reconcile late responses, and the bridge needs
// a single source of truth for which envelope versions each side
// understands.
//
// This module is pure (no `chrome.*` at import time). Tests inject the
// cancellation observer and the negotiation table.

export const ENVELOPE_CANCEL_VERSION = 1;
export const ENVELOPE_CANCEL_TYPE = "bridge.cancelled";

export function createEnvelopeCancellation({ now = Date.now } = {}) {
  const cancelled = new Map();
  const observers = new Set();

  function notify(event) {
    for (const fn of observers) {
      try {
        fn(event);
      } catch (error) {
        console.warn(`[envelope-cancellation] observer failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  function cancel({ envelopeId, reason = "user-cancelled", origin = "extension" }) {
    if (typeof envelopeId !== "string" || envelopeId.length === 0) {
      throw new Error("cancel requires an envelopeId");
    }
    const record = {
      envelopeId,
      reason,
      origin,
      cancelledAt: now(),
      version: ENVELOPE_CANCEL_VERSION,
    };
    cancelled.set(envelopeId, record);
    notify({ kind: "cancelled", record });
    return record;
  }

  function isCancelled(envelopeId) {
    return cancelled.has(envelopeId);
  }

  function reason(envelopeId) {
    return cancelled.get(envelopeId)?.reason ?? null;
  }

  function acknowledge(envelopeId) {
    const record = cancelled.get(envelopeId);
    if (!record) return null;
    cancelled.delete(envelopeId);
    notify({ kind: "acknowledged", record });
    return record;
  }

  function observe(fn) {
    if (typeof fn !== "function") throw new Error("observe requires a function");
    observers.add(fn);
    return () => observers.delete(fn);
  }

  function snapshot() {
    return [...cancelled.values()];
  }

  return { cancel, isCancelled, reason, acknowledge, observe, snapshot };
}

// Negotiation table: which envelope kinds each side understands, and
// how to negotiate downgrades. The host and the extension ship the same
// table; adding a new envelope type requires a paired update on both
// sides AND a test update.
export const ENVELOPE_PROTOCOL_FEATURES = Object.freeze({
  coreVersion: "0.1.0",
  extensionVersion: "0.1.0",
  supports: Object.freeze([
    "bridge.hello",
    "bridge.welcome",
    "bridge.compat.report",
    "bridge.heartbeat",
    "bridge.request",
    "bridge.response",
    "bridge.cancelled",
    "bridge.shutdown",
  ]),
});

function asString(value) {
  return typeof value === "string" ? value : null;
}

export function negotiateEnvelopeCompatibility({
  peerFeatures,
  localFeatures = ENVELOPE_PROTOCOL_FEATURES,
} = {}) {
  if (!peerFeatures || typeof peerFeatures !== "object") {
    return { ok: false, code: "malformed_features" };
  }
  const peerSupports = Array.isArray(peerFeatures.supports) ? peerFeatures.supports.filter(asString) : [];
  if (peerSupports.length === 0) {
    return { ok: false, code: "no_supported_envelopes" };
  }
  const peerCore = asString(peerFeatures.coreVersion);
  const peerExt = asString(peerFeatures.extensionVersion);
  if (!peerCore || !peerExt) return { ok: false, code: "missing_versions" };
  const shared = peerSupports.filter((type) => localFeatures.supports.includes(type));
  if (shared.length === 0) {
    return { ok: false, code: "no_shared_envelope_types" };
  }
  return {
    ok: true,
    shared,
    peerCoreVersion: peerCore,
    peerExtensionVersion: peerExt,
    localCoreVersion: localFeatures.coreVersion,
    localExtensionVersion: localFeatures.extensionVersion,
  };
}
