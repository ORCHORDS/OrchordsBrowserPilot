export const BRIDGE_PROTOCOL_VERSION = 1;
export const MAX_BRIDGE_MESSAGE_BYTES = 1024 * 1024;
export const DEFAULT_BRIDGE_TTL_MS = 30_000;
export const MAX_BRIDGE_TTL_MS = 5 * 60_000;
export const DEFAULT_REPLAY_WINDOW_SIZE = 256;

// #123 — explicit adapter-core version handshake.
//
// The extension is versioned together with the rest of the orchords-web-pilot
// product. The local native host advertises a single product version; the
// extension pins a min/max range. The handshake is performed by exchanging
// `bridge.hello` / `bridge.welcome` envelopes whose payload is a
// `BridgeCompatibility` record; both sides MUST refuse any payload outside
// the supported matrix. Adding a new core version therefore requires
// widening the matrix here and in the native-host companion — silently
// shipping an out-of-range version is a release-gate violation.

export const EXTENSION_MIN_CORE_VERSION = "0.1.0";
export const EXTENSION_MAX_CORE_VERSION = "0.1.x";

// Supported message types. `bridge.hello` / `bridge.welcome` /
// `bridge.compat.report` are reserved for the explicit handshake. They are
// pinned here so a regression that introduces a typo is caught by the
// unit tests.
export const BRIDGE_HELLO_TYPE = "bridge.hello";
export const BRIDGE_WELCOME_TYPE = "bridge.welcome";
export const BRIDGE_COMPAT_REPORT_TYPE = "bridge.compat.report";

// Backpressure (#123): the extension may not produce unlimited outbound
// envelopes. The bounded queue below is the only producer-side primitive
// permitted to feed `port.postMessage`.
export const DEFAULT_BRIDGE_OUTBOUND_LIMIT = 64;

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

// #123 — version handshake.
//
// Both sides declare the bridge-protocol version and the product version
// they ship. Each side independently validates the other side's payload
// against the matrix and refuses any envelope that would require a
// downgrade or an unknown major.

function parseSemver(major, minor, patch) {
  return {
    major: Number(major),
    minor: Number(minor),
    patch: patch === "x" || patch === undefined ? Number.POSITIVE_INFINITY : Number(patch),
  };
}

function compareSemver(a, b) {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

function parseVersion(version) {
  if (typeof version !== "string") return null;
  const m = /^(\d+)\.(\d+)(?:\.([0-9x]+))?$/.exec(version.trim());
  if (!m) return null;
  return parseSemver(m[1], m[2], m[3]);
}

function inRange(version, min, max) {
  const parsed = parseVersion(version);
  const parsedMin = parseVersion(min);
  const parsedMax = parseVersion(max);
  if (!parsed || !parsedMin || !parsedMax) return false;
  return compareSemver(parsed, parsedMin) >= 0 && compareSemver(parsed, parsedMax) <= 0;
}

export function createBridgeHelloPayload({
  extensionVersion,
  bridgeProtocol = BRIDGE_PROTOCOL_VERSION,
  minCoreVersion = EXTENSION_MIN_CORE_VERSION,
  maxCoreVersion = EXTENSION_MAX_CORE_VERSION,
} = {}) {
  if (typeof extensionVersion !== "string" || extensionVersion.length === 0) {
    throw new Error("bridge.hello requires an extension version");
  }
  return {
    kind: BRIDGE_HELLO_TYPE,
    bridgeProtocol,
    extensionVersion,
    minCoreVersion,
    maxCoreVersion,
  };
}

export function createBridgeWelcomePayload({
  coreVersion,
  bridgeProtocol = BRIDGE_PROTOCOL_VERSION,
  minExtensionVersion = EXTENSION_MIN_CORE_VERSION,
  maxExtensionVersion = EXTENSION_MAX_CORE_VERSION,
} = {}) {
  if (typeof coreVersion !== "string" || coreVersion.length === 0) {
    throw new Error("bridge.welcome requires a core version");
  }
  return {
    kind: BRIDGE_WELCOME_TYPE,
    bridgeProtocol,
    coreVersion,
    minExtensionVersion,
    maxExtensionVersion,
  };
}

export function createBridgeCompatReport({ coreVersion, extensionVersion }) {
  return {
    kind: BRIDGE_COMPAT_REPORT_TYPE,
    bridgeProtocol: BRIDGE_PROTOCOL_VERSION,
    coreVersion,
    extensionVersion,
  };
}

export function evaluateCompatibility({
  hello,
  welcome,
  minCoreVersion = EXTENSION_MIN_CORE_VERSION,
  maxCoreVersion = EXTENSION_MAX_CORE_VERSION,
  minExtensionVersion = EXTENSION_MIN_CORE_VERSION,
  maxExtensionVersion = EXTENSION_MAX_CORE_VERSION,
} = {}) {
  if (!hello || typeof hello !== "object") return { ok: false, code: "malformed_hello" };
  if (!welcome || typeof welcome !== "object") return { ok: false, code: "malformed_welcome" };
  if (hello.bridgeProtocol !== BRIDGE_PROTOCOL_VERSION) return { ok: false, code: "protocol_hello" };
  if (welcome.bridgeProtocol !== BRIDGE_PROTOCOL_VERSION) return { ok: false, code: "protocol_welcome" };
  if (typeof welcome.coreVersion !== "string") return { ok: false, code: "malformed_core_version" };
  if (typeof hello.extensionVersion !== "string") return { ok: false, code: "malformed_extension_version" };
  if (!inRange(welcome.coreVersion, minCoreVersion, maxCoreVersion)) {
    return { ok: false, code: "core_version_out_of_range", coreVersion: welcome.coreVersion };
  }
  if (!inRange(hello.extensionVersion, minExtensionVersion, maxExtensionVersion)) {
    return { ok: false, code: "extension_version_out_of_range", extensionVersion: hello.extensionVersion };
  }
  return { ok: true, coreVersion: welcome.coreVersion, extensionVersion: hello.extensionVersion };
}

// #123 — backpressure.
//
// The native-messaging pipe is a single buffered port; the extension must
// not push more than `limit` envelopes in flight. `BridgeOutboundQueue`
// implements a bounded FIFO with explicit rejection. Producers receive an
// `{ ok: false, code: "backpressure" }` result instead of a silent drop
// so the caller can throttle.
export class BridgeOutboundQueue {
  constructor({ limit = DEFAULT_BRIDGE_OUTBOUND_LIMIT } = {}) {
    this.limit = Math.max(1, Math.trunc(limit));
    this.pending = [];
  }

  size() {
    return this.pending.length;
  }

  capacity() {
    return this.limit;
  }

  enqueue(envelope) {
    if (!envelope || typeof envelope !== "object") {
      return { ok: false, code: "malformed_envelope" };
    }
    if (this.pending.length >= this.limit) {
      return { ok: false, code: "backpressure", capacity: this.limit };
    }
    this.pending.push(envelope);
    return { ok: true, position: this.pending.length };
  }

  // Drain the queue head; returns `null` if empty. Callers should
  // synchronously `port.postMessage` the drained envelope to keep the
  // FIFO aligned with the port.
  drainOne() {
    return this.pending.shift() ?? null;
  }

  drainAll() {
    const drained = this.pending.slice();
    this.pending.length = 0;
    return drained;
  }

  rejectIfExpired({ now = Date.now } = {}) {
    const kept = [];
    let expired = 0;
    for (const envelope of this.pending) {
      if (Number.isFinite(envelope.deadlineAt) && envelope.deadlineAt < now()) {
        expired += 1;
        continue;
      }
      kept.push(envelope);
    }
    this.pending = kept;
    return { expired, retained: kept.length };
  }
}
