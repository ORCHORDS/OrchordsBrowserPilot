import assert from "node:assert/strict";
import test from "node:test";

import manifest from "../extension/manifest.json" with { type: "json" };
import { renderSidePanel } from "../extension/side-panel.js";

function fakeDocument() {
  function makeEl() {
    return {
      children: [] as any[],
      dataset: {} as Record<string, string>,
      _text: "",
      get textContent() { return this._text; },
      set textContent(value: unknown) { this._text = String(value); },
      appendChild(child: any) { this.children.push(child); return child; },
      replaceChildren(...children: any[]) { this.children = children; },
      setAttribute() {},
    };
  }
  const body = makeEl();
  return {
    createElement: makeEl,
    getElementById: () => body,
    body,
  };
}

function eventSlot<T extends (...args: any[]) => any>() {
  let listener: T | undefined;
  return {
    event: { addListener(fn: T) { listener = fn; } },
    get listener() { return listener; },
  };
}

test("extension UI is not web-exposed and keeps a self-only extension CSP (#131)", () => {
  const raw = manifest as Record<string, any>;
  assert.equal("externally_connectable" in raw, false);
  assert.equal("web_accessible_resources" in raw, false);
  assert.equal(raw.content_security_policy.extension_pages, "script-src 'self'; object-src 'self';");
  assert.doesNotMatch(raw.content_security_policy.extension_pages, /unsafe-eval|https?:|data:/i);
});

test("side-panel renderer treats hostile page-derived origins as inert text (#131)", () => {
  const doc = fakeDocument();
  renderSidePanel({
    state: "observing",
    siteAuthorizations: {
      grants: [{ origin: 'https://evil.invalid/\"><img src=x onerror=alert(1)><script>pwn()</script>', kind: "session" }],
      denials: [],
    },
  }, doc);
  const registry = doc.body.children[2];
  const grantItem = registry.children[1].children[0];
  assert.doesNotMatch(grantItem.textContent, /<script>|<img/i);
  assert.match(grantItem.textContent, /&lt;script&gt;/);
  assert.match(grantItem.textContent, /&lt;img/);
});

test("real service-worker listener rejects foreign extension/page senders before dispatch (#131)", async () => {
  const onMessage = eventSlot<(message: any, sender: any, sendResponse: any) => boolean>();
  const onInstalled = eventSlot<(...args: any[]) => any>();
  const onStartup = eventSlot<(...args: any[]) => any>();
  const onClicked = eventSlot<(...args: any[]) => any>();
  let broadcasts = 0;
  let nativeConnects = 0;

  const nativePort = {
    postMessage() {},
    disconnect() {},
    onMessage: { addListener() {} },
    onDisconnect: { addListener() {} },
  };
  const storageArea = {
    async get() { return {}; },
    async set() {},
    async remove() {},
  };

  (globalThis as any).chrome = {
    runtime: {
      id: "trusted-extension-id",
      getManifest: () => ({ manifest_version: 3, version: "0.1.0" }),
      onMessage: onMessage.event,
      onInstalled: onInstalled.event,
      onStartup: onStartup.event,
      async sendMessage() { broadcasts += 1; },
      connectNative() { nativeConnects += 1; return nativePort; },
      lastError: undefined,
    },
    storage: { local: storageArea, session: storageArea },
    tabs: {
      async get() { return undefined; },
      async query() { return []; },
    },
    action: {
      onClicked: onClicked.event,
      async setBadgeBackgroundColor() {},
      async setBadgeText() {},
    },
    alarms: {
      create() {},
      onAlarm: { addListener() {} },
    },
  };

  try {
    await import(`../extension/service-worker.js?security-boundary=${Date.now()}`);
    assert.ok(onMessage.listener, "service worker must register chrome.runtime.onMessage");

    // Let import-time storage initializers settle, then establish a side-effect baseline.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const beforeBroadcasts = broadcasts;
    const beforeNativeConnects = nativeConnects;

    const result = onMessage.listener!(
      { kind: "user-action", action: "snapshot" },
      { id: "foreign-extension-id", url: "https://attacker.invalid/" },
      () => undefined,
    );
    assert.equal(result, false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(broadcasts, beforeBroadcasts, "untrusted sender must not trigger control-state broadcast");
    assert.equal(nativeConnects, beforeNativeConnects, "untrusted sender must not reach native bridge");
  } finally {
    delete (globalThis as any).chrome;
  }
});
