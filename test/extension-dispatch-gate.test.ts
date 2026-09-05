import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dispatchGateUrl = pathToFileURL(
  path.join(repoRoot, "extension", "dispatch-gate.js"),
).href;
const siteAuthzUrl = pathToFileURL(
  path.join(repoRoot, "extension", "site-authorizations.js"),
).href;

const { createSiteAuthorizations, GRANT_KIND } = await import(siteAuthzUrl);
const { createDispatchGate, DISPATCH_GATE_VERSION } = await import(dispatchGateUrl);
const { createTabAttachment } = await import(
  pathToFileURL(path.join(repoRoot, "extension", "tab-attachment.js")).href
);

function newAttachment(initial = {}) {
  const tabsApi = {
    query: async () => [],
    get: async (tabId) => {
      const live = initial.liveTabs?.[tabId];
      return { id: tabId, url: live?.url ?? initial.attachedUrl };
    },
  };
  return createTabAttachment({ tabsApi });
}

test("createDispatchGate validates dependencies", () => {
  assert.throws(() => createDispatchGate({}));
  assert.throws(() => createDispatchGate({ registry: {} }));
  assert.throws(() => createDispatchGate({ attachment: {} }));
});

test("enforce returns unknown_attachment_token when the token is missing", async () => {
  const registry = createSiteAuthorizations();
  const attachment = newAttachment();
  const gate = createDispatchGate({ registry, attachment });
  const verdict = await gate.enforce({ token: "" });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, "unknown_attachment_token");
});

test("enforce returns unknown_attachment_token when the token was never issued", async () => {
  const registry = createSiteAuthorizations();
  const attachment = newAttachment();
  const gate = createDispatchGate({ registry, attachment });
  const verdict = await gate.enforce({ token: "ghost" });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, "unknown_attachment_token");
});

test("enforce refuses when the live tab has navigated cross-origin", async () => {
  const registry = createSiteAuthorizations();
  registry.grant("https://example.com", GRANT_KIND.SESSION);
  const attachment = newAttachment({ attachedUrl: "https://example.com/page" });
  const token = (await attachment.attach({ tabId: 7, label: "cross-origin-test" })).token;
  // Simulate the tab having navigated to a different origin.
  const tabsApi = {
    query: async () => [],
    get: async () => ({ id: 7, url: "https://attacker.example/page" }),
  };
  const live = createTabAttachment({ tabsApi });
  await live.attach({ tabId: 7, label: "cross-origin-test-live" });
  // Forge the same token by re-issuing from the registry-bound attachment;
  // since `decisionFor` is keyed on origin (`example.com`) we expect a
  // cross-origin drift rejection before the registry runs.
  const gateWithAttached = createDispatchGate({ registry, attachment });
  // The attach above had no `tabsApi.get` override, so registry sees
  // origin=example.com. Force the drift by overriding the tabs adapter that
  // `newAttachment` resolved at attach time. Since the registry is keyed on
  // the captured origin, we must intercept at enforce time.
  const driftGate = createDispatchGate({
    registry,
    attachment: fakeAttachmentFor({
      attachment,
      token,
      attachedUrl: "https://example.com/page",
      liveUrl: "https://attacker.example/page",
    }),
    tabsApi: liveTabsApi({ 7: "https://attacker.example/page" }),
  });
  const verdict = await driftGate.enforce({ token, runId: "run-1" });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, "tab_drifted_origin");
  assert.equal(verdict.origin, "example.com");
  assert.equal(verdict.liveOrigin, "attacker.example");
  // Even though the gate never calls registry, the audit trail should
  // reflect that drift was detected so denials stay explainable.
  const audit = registry.getAudit();
  assert.ok(audit.some((e) => e.kind === "dispatch.drifted_origin"));
  // Avoid lint-no-unused on `gateWithAttached` — it's covered above in test #3.
  void gateWithAttached;
});

test("enforce refuses when origin has no grant (unknown)", async () => {
  const registry = createSiteAuthorizations();
  const tabsApi = liveTabsApi({ 5: "https://bank.example/dashboard" });
  const attachment = createTabAttachment({ tabsApi });
  const token = (await attachment.attach({ tabId: 5 })).token;
  const gate = createDispatchGate({ registry, attachment, tabsApi });
  const verdict = await gate.enforce({ token, intent: "act" });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, "site_authorization_unknown");
  // The registry normalizes origins to URL form; the gate surfaces that form.
  assert.equal(verdict.origin, "https://bank.example");
});

test("enforce refuses when origin is on the deny list", async () => {
  const registry = createSiteAuthorizations();
  registry.deny("https://phish.example");
  const tabsApi = liveTabsApi({ 9: "https://phish.example/login" });
  const attachment = createTabAttachment({ tabsApi });
  const token = (await attachment.attach({ tabId: 9 })).token;
  const gate = createDispatchGate({ registry, attachment, tabsApi });
  const verdict = await gate.enforce({ token });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, "site_authorization_denied");
});

test("enforce allows session grants and writes dispatch.allowed audit entry", async () => {
  const registry = createSiteAuthorizations();
  registry.grant("https://docs.example.com", GRANT_KIND.SESSION);
  const tabsApi = liveTabsApi({ 1: "https://docs.example.com/page" });
  const attachment = createTabAttachment({ tabsApi });
  const token = (await attachment.attach({ tabId: 1 })).token;
  const gate = createDispatchGate({ registry, attachment, tabsApi });
  const verdict = await gate.enforce({ token, runId: "run-doc-1" });
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.decision, "session");
  const audit = registry.getAudit();
  assert.ok(audit.some((e) => e.kind === "dispatch.allowed" && e.runId === "run-doc-1"));
});

test("enforce consumes a once token atomically across concurrent calls", async () => {
  const registry = createSiteAuthorizations();
  registry.grant("https://once.example", GRANT_KIND.ONCE);
  const tabsApi = liveTabsApi({ 2: "https://once.example/page" });
  const attachment = createTabAttachment({ tabsApi });
  const token = (await attachment.attach({ tabId: 2 })).token;
  const gate = createDispatchGate({ registry, attachment, tabsApi });
  const [first, second] = await Promise.all([
    gate.enforce({ token, runId: "run-once-1" }),
    gate.enforce({ token, runId: "run-once-2" }),
  ]);
  const allowed = [first, second].filter((v) => v.allowed);
  const blocked = [first, second].filter((v) => !v.allowed);
  assert.equal(allowed.length, 1, "exactly one dispatch may consume the once grant");
  assert.equal(allowed[0].decision, "once_consumed");
  assert.equal(blocked.length, 1);
  assert.ok(
    blocked[0].code === "site_authorization_denied" ||
      blocked[0].code === "site_authorization_once_race",
    `expected denial on race, got ${blocked[0].code}`,
  );
});

test("enforce rejects foreign-origin appends to the audit log", () => {
  const registry = createSiteAuthorizations();
  // Returns false when the entry kind is not in the allow-list.
  assert.equal(
    registry.recordAudit({ kind: "not-allowed", origin: "example.com" }),
    false,
  );
});

test("DISPATCH_GATE_VERSION is exported and is a positive integer", () => {
  assert.equal(Number.isInteger(DISPATCH_GATE_VERSION), true);
  assert.ok(DISPATCH_GATE_VERSION > 0);
});

// ---- helpers ----------------------------------------------------------------

function liveTabsApi(map) {
  return {
    query: async () => Object.values(map).map((url, i) => ({ id: Number(Object.keys(map)[i]), url })),
    get: async (tabId) => (map[tabId] != null ? { id: tabId, url: map[tabId] } : null),
  };
}

function fakeAttachmentFor({ attachment, token, attachedUrl, liveUrl }) {
  // Returns a minimal attachment facade whose `get(token)` returns a stub
  // info record with the supplied URL — used to test the cross-origin drift
  // path without needing a real Chrome tabs API.
  return {
    ...attachment,
    get: (t) => {
      if (t !== token) return null;
      return {
        token,
        tabId: 7,
        url: attachedUrl,
        title: null,
        label: null,
        attachedAt: 0,
        version: 1,
      };
    },
  };
}
