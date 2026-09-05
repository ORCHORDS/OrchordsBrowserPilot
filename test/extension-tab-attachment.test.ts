import assert from "node:assert/strict";
import test from "node:test";

import {
  TAB_ATTACHMENT_VERSION,
  canonicalTabUrl,
  createTabAttachment,
} from "../extension/tab-attachment.js";

function fakeTabsApi(tabs) {
  return {
    async get(id) {
      return tabs.find((t) => t.id === id) ?? null;
    },
    async query({ url }) {
      return tabs.filter((t) => typeof t.url === "string" && t.url.includes(url));
    },
  };
}

test("canonicalTabUrl lowercases host and drops default port (#126)", () => {
  assert.equal(canonicalTabUrl("https://Example.COM:443/foo?bar=1"), "https://example.com/foo?bar=1");
  assert.equal(canonicalTabUrl("http://example.com"), "http://example.com/");
  assert.equal(canonicalTabUrl("javascript:alert(1)"), null);
  assert.equal(canonicalTabUrl("not-a-url"), null);
  assert.equal(canonicalTabUrl(""), null);
  assert.equal(canonicalTabUrl(null), null);
});

test("attach by tabId resolves and records a monotonic token (#126)", async () => {
  let i = 0;
  const tabs = [{ id: 7, url: "https://example.com/foo", title: "Foo", active: true }];
  const attachment = createTabAttachment({
    tabsApi: fakeTabsApi(tabs),
    now: () => 1_000 + i++,
    randomNonce: () => `nonce-${i}`,
  });
  const info = await attachment.attach({ tabId: 7, label: "primary" });
  assert.equal(info.tabId, 7);
  assert.equal(info.url, "https://example.com/foo");
  assert.equal(info.label, "primary");
  assert.equal(info.version, TAB_ATTACHMENT_VERSION);
  assert.match(info.token, /^nonce-\d+$/);
  assert.equal(attachment.list().length, 1);
});

test("attach by urlPrefix prefers the active tab (#126)", async () => {
  const tabs = [
    { id: 1, url: "https://example.com/a", active: false },
    { id: 2, url: "https://example.com/b", active: true },
    { id: 3, url: "https://example.com/c", active: false },
  ];
  const attachment = createTabAttachment({ tabsApi: fakeTabsApi(tabs) });
  const info = await attachment.attach({ urlPrefix: "https://example.com" });
  assert.equal(info.tabId, 2);
});

test("attach fails when no tab matches and when both inputs are missing (#126)", async () => {
  const attachment = createTabAttachment({ tabsApi: fakeTabsApi([]) });
  await assert.rejects(() => attachment.attach({ urlPrefix: "https://example.com" }), /no tab matched/);
  await assert.rejects(() => attachment.attach({}), /tabId or urlPrefix/);
});

test("detach emits a lifecycle event and removes the token (#126)", async () => {
  const tabs = [{ id: 1, url: "https://example.com/", active: true }];
  const events = [];
  const attachment = createTabAttachment({ tabsApi: fakeTabsApi(tabs) });
  const off = attachment.onEvent((event) => events.push(event));
  const info = await attachment.attach({ tabId: 1 });
  const result = await attachment.detach(info.token, { reason: "test" });
  assert.deepEqual(result, { ok: true });
  assert.equal(attachment.list().length, 0);
  off();
  assert.equal(events.length, 2);
  assert.equal(events[0].kind, "attached");
  assert.equal(events[1].kind, "detached");
  assert.equal(events[1].reason, "test");
});

test("attachments older than maxAgeMs are swept on resolve (#126)", async () => {
  let now = 1_000_000;
  const tabs = [{ id: 1, url: "https://example.com/" }];
  const attachment = createTabAttachment({ tabsApi: fakeTabsApi(tabs), now: () => now });
  await attachment.attach({ tabId: 1 });
  assert.equal(attachment.list().length, 1);
  now += 6 * 60_000; // past MAX_TAB_ATTACH_AGE_MS
  // trigger sweep via resolveTab
  await attachment.resolveTab({ tabId: 1 });
  assert.equal(attachment.list().length, 0);
});
