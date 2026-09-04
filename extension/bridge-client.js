import { attachBridgeAuth, verifyBridgeEnvelopeAuth } from "./bridge-auth.js";
import { createBridgeEnvelope } from "./bridge-protocol.js";

function requirePairing(pairing) {
  if (
    !pairing ||
    typeof pairing !== "object" ||
    typeof pairing.pairingId !== "string" ||
    typeof pairing.secret !== "string" ||
    !Number.isInteger(pairing.generation)
  ) {
    throw new Error("authenticated bridge client requires a pairing credential");
  }
  return pairing;
}

function splitAuthenticatedMessage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new Error("native bridge response is malformed");
  }
  const { auth, ...envelope } = message;
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) {
    throw new Error("native bridge response is unauthenticated");
  }
  return { auth, envelope };
}

function responseRequestId(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || typeof payload.requestId !== "string") {
    throw new Error("native bridge response requestId is malformed");
  }
  return payload.requestId;
}

export class AuthenticatedBridgeClient {
  constructor(port, pairing, options = {}) {
    if (!port || typeof port.postMessage !== "function") throw new Error("native bridge port is required");
    this.port = port;
    this.pairing = requirePairing(pairing);
    this.envelopeOptions = options.envelopeOptions ?? {};
    this.now = options.now ?? this.envelopeOptions.now ?? Date.now;
    this.setTimeout = options.setTimeout ?? globalThis.setTimeout.bind(globalThis);
    this.clearTimeout = options.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
    this.pending = new Map();
    this.closed = false;
  }

  async startRequest(tool, args = {}) {
    if (this.closed) throw new Error("native bridge client is disconnected");
    if (typeof tool !== "string" || !tool) throw new Error("native bridge tool is required");
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("native bridge arguments are malformed");

    const envelope = createBridgeEnvelope(
      "bridge.request",
      { tool, arguments: args },
      this.envelopeOptions,
    );
    const authenticated = await attachBridgeAuth(this.pairing, envelope);
    let resolveResponse;
    let rejectResponse;
    const response = new Promise((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    const timeoutMs = Math.max(0, envelope.deadlineAt - this.now());
    const timer = this.setTimeout(() => {
      const pending = this.pending.get(envelope.id);
      if (!pending) return;
      this.pending.delete(envelope.id);
      pending.reject(new Error("native bridge request deadline exceeded"));
    }, timeoutMs);
    if (timer && typeof timer.unref === "function") timer.unref();
    this.pending.set(envelope.id, { resolve: resolveResponse, reject: rejectResponse, timer });
    try {
      this.port.postMessage(authenticated);
    } catch (error) {
      const pending = this.pending.get(envelope.id);
      if (pending) this.clearTimeout(pending.timer);
      this.pending.delete(envelope.id);
      rejectResponse(error);
      throw error;
    }
    return { requestId: envelope.id, response };
  }

  async cancel(requestId) {
    if (this.closed) throw new Error("native bridge client is disconnected");
    if (typeof requestId !== "string" || !requestId) throw new Error("native bridge requestId is required");
    const envelope = createBridgeEnvelope("bridge.cancel", { requestId }, this.envelopeOptions);
    this.port.postMessage(await attachBridgeAuth(this.pairing, envelope));
    return envelope.id;
  }

  async handleMessage(message) {
    const { auth, envelope } = splitAuthenticatedMessage(message);
    if (!(await verifyBridgeEnvelopeAuth(this.pairing, envelope, auth))) {
      throw new Error("native bridge response authentication failed");
    }
    if (envelope.type !== "bridge.response" && envelope.type !== "bridge.cancelled") return false;

    const requestId = responseRequestId(envelope.payload);
    if (envelope.type === "bridge.cancelled") return this.pending.has(requestId);

    const pending = this.pending.get(requestId);
    if (!pending) return false;
    this.pending.delete(requestId);
    this.clearTimeout(pending.timer);
    if (typeof envelope.payload.error === "string" && envelope.payload.error) {
      pending.reject(new Error(envelope.payload.error));
    } else {
      pending.resolve(envelope.payload.result);
    }
    return true;
  }

  disconnect(reason = "native bridge disconnected") {
    if (this.closed) return;
    this.closed = true;
    const error = reason instanceof Error ? reason : new Error(String(reason));
    for (const pending of this.pending.values()) {
      this.clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
