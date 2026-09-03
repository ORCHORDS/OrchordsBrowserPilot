export const BRIDGE_PROTOCOL_VERSION = 1;
export const MAX_BRIDGE_MESSAGE_BYTES = 1024 * 1024;
export const DEFAULT_BRIDGE_TTL_MS = 30_000;
export const MAX_BRIDGE_TTL_MS = 5 * 60_000;
export const DEFAULT_REPLAY_WINDOW_SIZE = 256;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function defaultRandomNonce() {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function encodedBytes(value) {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export class ReplayWindow {
  constructor(initial = [], limit = DEFAULT_REPLAY_WINDOW_SIZE) {
    this.limit = Math.max(1, Math.trunc(limit));
    this.keys = [];
    this.set = new Set();
    for (const key of initial) this.addKey(key);
  }

  static key(envelope) {
    return `${envelope.id}:${envelope.nonce}`;
  }

  has(envelope) {
    return this.hasKey(ReplayWindow.key(envelope));
  }

  hasKey(key) {
    return this.set.has(key);
  }

  add(envelope) {
    this.addKey(ReplayWindow.key(envelope));
  }

  addKey(key) {
    if (typeof key !== "string" || !key || this.set.has(key)) return;
    this.keys.push(key);
    this.set.add(key);
    while (this.keys.length > this.limit) {
      const evicted = this.keys.shift();
      if (evicted !== undefined) this.set.delete(evicted);
    }
  }

  toJSON() {
    return [...this.keys];
  }
}

export function createBridgeEnvelope(type, payload, options = {}) {
  const now = options.now ?? Date.now;
  const randomUUID = options.randomUUID ?? (() => globalThis.crypto.randomUUID());
  const randomNonce = options.randomNonce ?? defaultRandomNonce;
  const ttlMs = options.ttlMs ?? DEFAULT_BRIDGE_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > MAX_BRIDGE_TTL_MS) {
    throw new Error("invalid bridge ttl");
  }
  return {
    protocol: BRIDGE_PROTOCOL_VERSION,
    id: randomUUID(),
    nonce: randomNonce(),
    deadlineAt: now() + ttlMs,
    type,
    payload,
  };
}

export function validateBridgeEnvelope(message, options = {}) {
  const now = options.now ?? Date.now;
  const replay = options.replay ?? new ReplayWindow();

  if (!message || typeof message !== "object" || Array.isArray(message)) return { ok: false, code: "malformed" };
  if (encodedBytes(message) > MAX_BRIDGE_MESSAGE_BYTES) return { ok: false, code: "too_large" };
  if (message.protocol !== BRIDGE_PROTOCOL_VERSION) return { ok: false, code: "protocol" };
  if (typeof message.type !== "string" || !message.type || typeof message.id !== "string" || !UUID_RE.test(message.id)) {
    return { ok: false, code: "malformed" };
  }
  if (typeof message.nonce !== "string" || message.nonce.length < 32 || message.nonce.length > 256) {
    return { ok: false, code: "malformed" };
  }
  if (!Number.isFinite(message.deadlineAt)) return { ok: false, code: "malformed" };
  if (message.deadlineAt < now()) return { ok: false, code: "expired" };
  if (message.deadlineAt > now() + MAX_BRIDGE_TTL_MS) return { ok: false, code: "deadline_too_far" };
  if (replay.has(message)) return { ok: false, code: "replay" };
  return { ok: true };
}
