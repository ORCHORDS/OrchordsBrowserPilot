// Content-script isolated-world relay (#127).
//
// The MV3 service worker cannot read page content directly. A content
// script runs in the page's main world; an isolated-world relay runs as a
// service-worker-attached module that forwards messages between the
// content script and the service worker via `runtime.connect`.
//
// This module is pure: it accepts an injected transport (`chrome.runtime`)
// and exposes a tiny envelope-shaped message contract. It MUST NOT call
// any privileged API itself; every privileged operation (debugger attach,
// cookies read, etc.) is gated by the service worker and the privileged-API
// inventory.

export const RELAY_PROTOCOL_VERSION = 1;
export const RELAY_KIND = Object.freeze({
  PAGE_EVENT: "page-event",
  PAGE_QUERY: "page-query",
  PAGE_RESPONSE: "page-response",
  RELAY_HELLO: "relay.hello",
});

function defaultRandomId() {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function createBridgeRelay({ runtime, now = Date.now, randomId = defaultRandomId } = {}) {
  if (!runtime || typeof runtime.connect !== "function") {
    throw new Error("BridgeRelay requires a chrome.runtime-shaped adapter");
  }
  const inflight = new Map();
  let port = null;

  function ensurePort() {
    if (port) return port;
    port = runtime.connect({ name: "orchords-relay" });
    port.onMessage?.addListener?.((message) => {
      if (!message || message.kind !== RELAY_KIND.PAGE_RESPONSE) return;
      const pending = inflight.get(message.id);
      if (!pending) return;
      inflight.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.payload);
    });
    port.onDisconnect?.addListener?.(() => {
      for (const [, pending] of inflight) {
        clearTimeout(pending.timer);
        pending.reject(new Error("relay disconnected"));
      }
      inflight.clear();
      port = null;
    });
    return port;
  }

  async function sendToPage(payload, { timeoutMs = 5_000 } = {}) {
    const id = randomId();
    const port = ensurePort();
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        inflight.delete(id);
        reject(new Error("relay response timed out"));
      }, Math.max(1, Math.trunc(timeoutMs)));
      inflight.set(id, { resolve, reject, timer });
      port.postMessage({
        kind: RELAY_KIND.PAGE_QUERY,
        id,
        protocol: RELAY_PROTOCOL_VERSION,
        issuedAt: now(),
        payload,
      });
    });
  }

  function publish(event) {
    const port = ensurePort();
    port.postMessage({
      kind: RELAY_KIND.PAGE_EVENT,
      protocol: RELAY_PROTOCOL_VERSION,
      issuedAt: now(),
      payload: event,
    });
  }

  function hello() {
    return {
      kind: RELAY_KIND.RELAY_HELLO,
      protocol: RELAY_PROTOCOL_VERSION,
      issuedAt: now(),
    };
  }

  function disconnect() {
    try {
      port?.disconnect?.();
    } catch {
      // ignore
    }
    port = null;
    for (const [, pending] of inflight) {
      clearTimeout(pending.timer);
      pending.reject(new Error("relay closed"));
    }
    inflight.clear();
  }

  return { sendToPage, publish, hello, disconnect };
}
