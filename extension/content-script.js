// Page-side content script (#127).
//
// Runs in the page's main world (manifest entries restricted to the
// canonical MCP origin in production deployments; for the open-source
// release we inject only on user-granted origins via `activeTab`).
//
// Listens for `relay.*` messages from the service worker over
// `runtime.connect`, performs the requested read-only inspection of the
// page, and posts `page-response` envelopes back. The script is
// intentionally minimal — it MUST NOT mutate the DOM and MUST NOT call
// any privileged API beyond `runtime.connect` / `runtime.sendMessage`.

(function () {
  if (typeof globalThis === "undefined") return;
  if (globalThis.__orchordsContentScriptInstalled) return;
  globalThis.__orchordsContentScriptInstalled = true;

  const RELAY_PROTOCOL_VERSION = 1;
  const KIND = {
    PAGE_QUERY: "page-query",
    PAGE_RESPONSE: "page-response",
    RELAY_HELLO: "relay.hello",
  };

  function readDomSnapshot(maxNodes) {
    const limit = Math.max(1, Math.min(1024, Math.trunc(maxNodes ?? 256)));
    const nodes = [];
    const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_ELEMENT);
    let n;
    let i = 0;
    while ((n = walker.nextNode()) && i < limit) {
      nodes.push({
        tag: n.tagName.toLowerCase(),
        role: n.getAttribute?.("role") ?? null,
        text: (n.textContent ?? "").slice(0, 240),
      });
      i += 1;
    }
    return { count: nodes.length, nodes };
  }

  function readMeta() {
    const title = document.title ?? null;
    const url = location.href;
    return { title, url };
  }

  function respond(id, payload) {
    try {
      globalThis.chrome?.runtime?.sendMessage?.({
        kind: KIND.PAGE_RESPONSE,
        id,
        protocol: RELAY_PROTOCOL_VERSION,
        payload,
      });
    } catch {
      // runtime may not be available; swallow.
    }
  }

  function reject(id, message) {
    try {
      globalThis.chrome?.runtime?.sendMessage?.({
        kind: KIND.PAGE_RESPONSE,
        id,
        protocol: RELAY_PROTOCOL_VERSION,
        error: message,
      });
    } catch {
      // ignore
    }
  }

  if (typeof globalThis.chrome === "undefined" || !globalThis.chrome.runtime?.onMessage) {
    return;
  }

  globalThis.chrome.runtime.onMessage.addListener((message, _sender, _sendResponse) => {
    if (!message || message.kind !== KIND.PAGE_QUERY) return;
    if (message.protocol !== RELAY_PROTOCOL_VERSION) {
      reject(message.id, "protocol mismatch");
      return;
    }
    try {
      const op = message.payload?.op;
      if (op === "meta") return respond(message.id, readMeta());
      if (op === "dom") return respond(message.id, readDomSnapshot(message.payload?.max));
      reject(message.id, `unknown op: ${String(op)}`);
    } catch (error) {
      reject(message.id, error instanceof Error ? error.message : String(error));
    }
  });
})();
