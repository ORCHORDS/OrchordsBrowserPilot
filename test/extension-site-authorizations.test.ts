import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const siteAuthzUrl = pathToFileURL(
  path.join(repoRoot, "extension", "site-authorizations.js"),
).href;
const popupJsPath = path.join(repoRoot, "extension", "popup.js");
const serviceWorkerPath = path.join(repoRoot, "extension", "service-worker.js");

const { GRANT_KIND, createSiteAuthorizations, STORAGE_KEY_EXPORT } =
  await import(siteAuthzUrl);

function deterministicNowFactory(stepMs = 1_000) {
  let t = 1_700_000_000_000;
  return () => {
    const now = t;
    t += stepMs;
    return now;
  };
}

test("grant kind enumeration is frozen and canonical (#124)", () => {
  assert.equal(GRANT_KIND.ONCE, "once");
  assert.equal(GRANT_KIND.SESSION, "session");
  assert.equal(GRANT_KIND.SITE, "site");
  assert.equal(Object.isFrozen(GRANT_KIND), true);
});

test("persistent site grants survive durable hydration while legacy session grants do not (#124)", () => {
  const reg = createSiteAuthorizations();
  reg.grant("https://site.example.com", GRANT_KIND.SITE);
  reg.grant("https://session.example.com", GRANT_KIND.SESSION);

  const durable = reg.durableSnapshot();
  assert.deepEqual(
    durable.grants.map((entry) => [entry.origin, entry.kind]),
    [["https://site.example.com", GRANT_KIND.SITE]],
  );

  const hydrated = createSiteAuthorizations(durable);
  assert.equal(hydrated.decisionFor("https://site.example.com/path").kind, "allowed");
  assert.equal(hydrated.decisionFor("https://site.example.com/path").grantKind, GRANT_KIND.SITE);
  assert.equal(hydrated.decisionFor("https://session.example.com/path").kind, "unknown");
});

test("canonical origin: lower-cased host, scheme, no default port, no path (#124)", () => {
  const reg = createSiteAuthorizations();
  // Lower-case host.
  assert.equal(
    reg.grant("https://Example.com", GRANT_KIND.SESSION),
    true,
  );
  // Look up with mixed case and trailing slash: must still resolve.
  const d = reg.decisionFor("HTTPS://example.com/whatever?q=1");
  assert.equal(d.kind, "allowed");
  assert.equal(d.origin, "https://example.com");

  // Default port for https (443) is stripped.
  const reg2 = createSiteAuthorizations();
  reg2.grant("https://example.com:443", GRANT_KIND.SESSION);
  assert.equal(
    reg2.decisionFor("https://example.com:443/path").kind,
    "allowed",
  );
  assert.equal(
    reg2.decisionFor("https://example.com").kind,
    "allowed",
  );
});

test("reject non-http(s) origins and unparseable URLs (#124)", () => {
  const reg = createSiteAuthorizations();
  assert.throws(
    () => reg.grant("file:///etc/passwd", GRANT_KIND.SESSION),
    /valid http\(s\) origin/,
  );
  assert.throws(
    () => reg.grant("chrome-extension://abcd/popup.html", GRANT_KIND.SESSION),
    /valid http\(s\) origin/,
  );
  assert.throws(() => reg.grant(null, GRANT_KIND.SESSION), /valid http\(s\) origin/);
  assert.throws(() => reg.grant("", GRANT_KIND.SESSION), /valid http\(s\) origin/);
  assert.throws(() => reg.deny("javascript:alert(1)"), /valid http\(s\) origin/);
  assert.throws(() => reg.revoke(123), /valid http\(s\) origin/);

  const d = reg.decisionFor("not a url");
  assert.equal(d.kind, "denied");
  assert.equal(d.origin, null);
});

test("decisionFor returns unknown when no grant or denial exists (#124)", () => {
  const reg = createSiteAuthorizations();
  const d = reg.decisionFor("https://nope.example.com/");
  assert.equal(d.kind, "unknown");
  assert.equal(d.origin, "https://nope.example.com");
});

test("deny blocks all further grants until explicitly overridden by the user (#124)", () => {
  const reg = createSiteAuthorizations();
  reg.deny("https://blocked.example.com", "user denied");
  assert.equal(
    reg.decisionFor("https://blocked.example.com/").kind,
    "denied",
  );
  assert.equal(
    reg.decisionFor("https://blocked.example.com").reason,
    "origin explicitly denied",
  );
  // A later grant lifts the deny and records the grant.
  reg.grant("https://blocked.example.com", GRANT_KIND.SESSION);
  assert.equal(
    reg.decisionFor("https://blocked.example.com/").kind,
    "allowed",
  );
});

test("ONCE grant is consumed by the first dispatch and blocks subsequent ones (#124)", () => {
  const reg = createSiteAuthorizations();
  reg.grant("https://once.example.com", GRANT_KIND.ONCE);
  // First decision: allowed, pending consumption.
  const first = reg.decisionFor("https://once.example.com/");
  assert.equal(first.kind, "allowed");
  assert.equal(first.grantKind, GRANT_KIND.ONCE);
  assert.equal(reg.consumeOnce("https://once.example.com/"), true);
  // Second decision without re-grant must be denied.
  const second = reg.decisionFor("https://once.example.com/");
  assert.equal(second.kind, "denied");
  assert.equal(second.reason, "once grant already consumed");
  // consumeOnce returns false now.
  assert.equal(reg.consumeOnce("https://once.example.com/"), false);
});

test("revoke removes both grants and denials and is idempotent (#124)", () => {
  const reg = createSiteAuthorizations();
  reg.grant("https://a.example.com", GRANT_KIND.SESSION);
  reg.deny("https://b.example.com");
  assert.equal(reg.revoke("https://a.example.com"), true);
  assert.equal(reg.revoke("https://b.example.com"), true);
  assert.equal(reg.revoke("https://never-seen.example.com"), false);
  assert.equal(reg.decisionFor("https://a.example.com/").kind, "unknown");
  assert.equal(reg.decisionFor("https://b.example.com/").kind, "unknown");
});

test("deny removes a prior grant to avoid implicit bypass (#124)", () => {
  const reg = createSiteAuthorizations();
  reg.grant("https://flip.example.com", GRANT_KIND.SESSION);
  assert.equal(reg.decisionFor("https://flip.example.com/").kind, "allowed");
  reg.deny("https://flip.example.com");
  assert.equal(reg.decisionFor("https://flip.example.com/").kind, "denied");
});

test("snapshot round-trips through JSON, audit is bounded, onceUsed serialised (#124)", async () => {
  const reg = createSiteAuthorizations({ now: deterministicNowFactory() });
  reg.grant("https://s.example.com", GRANT_KIND.SESSION);
  reg.grant("https://o.example.com", GRANT_KIND.ONCE);
  reg.consumeOnce("https://o.example.com/");
  reg.deny("https://d.example.com");

  const snap = reg.snapshot();
  const json = JSON.parse(JSON.stringify(snap));
  assert.deepEqual(
    json.grants.map((g) => g.origin).sort(),
    ["https://o.example.com", "https://s.example.com"],
  );
  assert.deepEqual(json.denials, ["https://d.example.com"]);
  assert.deepEqual(json.onceUsed, ["https://o.example.com"]);
  assert.equal(json.audit.length, 4); // grant x2, consume-once, deny
  assert.equal(json.audit[0].kind, "grant");
  assert.equal(json.audit[3].kind, "deny");

  // Audit log is bounded by auditLimit.
  const reg2 = createSiteAuthorizations({
    now: deterministicNowFactory(1),
    auditLimit: 3,
  });
  for (const origin of ["https://a", "https://b", "https://c", "https://d"]) {
    reg2.grant(origin, GRANT_KIND.SESSION);
  }
  // auditLimit caps the rolling buffer at the latest 3 entries.
  assert.equal(reg2.getAudit().length, 3);
  // The oldest entry was dropped; the surviving ones are the last three grants.
  const kinds = reg2.getAudit().map((e) => e.kind);
  assert.deepEqual(kinds, ["grant", "grant", "grant"]);
});

test("storage key is exported and matches the on-disk contract (#124)", () => {
  assert.equal(STORAGE_KEY_EXPORT, "orchordsSiteAuthorizations");
});

test("popup.js wires site authorization into the user-action dispatcher (#124)", async () => {
  const popupJs = await readFile(popupJsPath, "utf8");
  // The popup must surface allow_once / allow_for_session / deny_site /
  // revoke_site as user-action kinds so the service worker can route them.
  for (const action of [
    "allow_once",
    "allow_for_session",
    "deny_site",
    "revoke_site",
  ]) {
    assert.ok(
      popupJs.includes(action),
      `popup.js must reference user-action kind "${action}"`,
    );
  }
  // The popup must import the authorization module so the buttons can
  // resolve a decision before dispatching.
  assert.match(
    popupJs,
    /site-authorizations\.js/,
    "popup.js must import the site-authorizations module",
  );
});

test("service-worker.js persists and consults the site-authorization registry (#124)", async () => {
  const sw = await readFile(serviceWorkerPath, "utf8");
  assert.match(
    sw,
    /site-authorizations\.js/,
    "service-worker.js must import the site-authorizations module",
  );
  // The service worker is the sole writer; it must own the storage key
  // (either inline or via the exported constant).
  assert.match(
    sw,
    /SITE_AUTHZ_STORAGE_KEY|orchordsSiteAuthorizations/,
    "service-worker.js must reference the canonical storage key",
  );
  // The service worker must wire all four user-action kinds.
  for (const action of [
    "allow_once",
    "allow_for_session",
    "deny_site",
    "revoke_site",
  ]) {
    assert.ok(
      sw.includes(action),
      `service-worker.js must handle user-action "${action}"`,
    );
  }
});
