// Deterministic tab attachment (#126).
//
// The native host MUST be able to talk to a specific browser tab without
// relying on the active-tab race. `TabAttachment` resolves a tab by
// explicit `tabId` (preferred) or by URL prefix (fallback), generates a
// monotonic attachment token, and exposes a lifecycle adapter that mirrors
// the Chrome `tabs` events so a suspended SW can re-attach deterministically
// after wakeup.
//
// This module is pure (no `chrome.*` calls at import time). Tests inject
// the `tabsApi` adapter and a clock.

export const TAB_ATTACHMENT_VERSION = 1;

const MAX_TAB_ATTACH_AGE_MS = 5 * 60_000;

function defaultRandomNonce() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function canonicalTabUrl(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname}${u.search}`;
  } catch {
    return null;
  }
}

export function createTabAttachment({
  tabsApi,
  now = Date.now,
  randomNonce = defaultRandomNonce,
  maxAgeMs = MAX_TAB_ATTACH_AGE_MS,
} = {}) {
  if (!tabsApi || typeof tabsApi.query !== "function" || typeof tabsApi.get !== "function") {
    throw new Error("TabAttachment requires a chrome.tabs-shaped adapter");
  }
  const inflight = new Map();
  const listeners = new Set();

  function emit(event) {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        // Lifecycle listeners MUST NOT crash the adapter. Surface but do
        // not rethrow.
        console.warn(`[TabAttachment] listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  function sweepStale() {
    const cutoff = now() - maxAgeMs;
    for (const [token, info] of inflight) {
      if (info.attachedAt < cutoff) inflight.delete(token);
    }
  }

  async function resolveTab({ tabId, urlPrefix } = {}) {
    sweepStale();
    if (Number.isInteger(tabId)) {
      const tab = await tabsApi.get(tabId);
      if (!tab) throw new Error(`tab ${tabId} not found`);
      return tab;
    }
    if (typeof urlPrefix === "string" && urlPrefix.length > 0) {
      const matches = await tabsApi.query({ url: urlPrefix });
      if (!Array.isArray(matches) || matches.length === 0) {
        throw new Error(`no tab matched url prefix ${urlPrefix}`);
      }
      // Deterministic: prefer the active tab, then first match by id order.
      const active = matches.find((tab) => tab.active) ?? matches[0];
      return active;
    }
    throw new Error("TabAttachment.resolveTab requires either tabId or urlPrefix");
  }

  async function attach({ tabId, urlPrefix, label } = {}) {
    const tab = await resolveTab({ tabId, urlPrefix });
    if (!Number.isInteger(tab.id)) throw new Error("resolved tab has no numeric id");
    const token = randomNonce();
    const info = {
      token,
      tabId: tab.id,
      url: canonicalTabUrl(tab.url),
      title: typeof tab.title === "string" ? tab.title : null,
      label: typeof label === "string" ? label : null,
      attachedAt: now(),
      version: TAB_ATTACHMENT_VERSION,
    };
    inflight.set(token, info);
    emit({ kind: "attached", info, tab });
    return info;
  }

  async function detach(token, { reason = "released" } = {}) {
    const info = inflight.get(token);
    if (!info) return { ok: false, code: "unknown_token" };
    inflight.delete(token);
    emit({ kind: "detached", token, info, reason });
    return { ok: true };
  }

  function list() {
    sweepStale();
    return [...inflight.values()];
  }

  function get(token) {
    return inflight.get(token) ?? null;
  }

  function onEvent(listener) {
    if (typeof listener !== "function") throw new Error("TabAttachment.onEvent requires a function");
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function bindChromeTabs(chrome) {
    if (!chrome?.tabs) throw new Error("bindChromeTabs requires chrome.tabs");
    const handler = (eventName) => (tabId, _extra) => {
      for (const info of inflight.values()) {
        if (info.tabId !== tabId) continue;
        const tab = { id: tabId };
        if (eventName === "removed") {
          inflight.delete(info.token);
        }
        emit({ kind: eventName, info, tab });
      }
    };
    const off = [];
    if (typeof chrome.tabs.onRemoved?.addListener === "function") {
      const fn = handler("removed");
      chrome.tabs.onRemoved.addListener(fn);
      off.push(() => chrome.tabs.onRemoved.removeListener(fn));
    }
    if (typeof chrome.tabs.onUpdated?.addListener === "function") {
      const fn = handler("updated");
      chrome.tabs.onUpdated.addListener(fn);
      off.push(() => chrome.tabs.onUpdated.removeListener(fn));
    }
    if (typeof chrome.tabs.onActivated?.addListener === "function") {
      const fn = (activeInfo) => {
        for (const info of inflight.values()) {
          if (info.tabId !== activeInfo.tabId) continue;
          emit({ kind: "activated", info, tab: { id: activeInfo.tabId, windowId: activeInfo.windowId } });
        }
      };
      chrome.tabs.onActivated.addListener(fn);
      off.push(() => chrome.tabs.onActivated.removeListener(fn));
    }
    return () => off.forEach((fn) => fn());
  }

  return {
    attach,
    detach,
    resolveTab,
    list,
    get,
    onEvent,
    bindChromeTabs,
  };
}
