import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const siteAuthzUrl = pathToFileURL(
  path.join(repoRoot, "extension", "site-authorizations.js"),
).href;
const popupHtmlPath = path.join(repoRoot, "extension", "popup.html");
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
  assert.equal(reg.grant("https://Example.com", GRANT_KIND.SITE), true);
  const d = reg.decisionFor("HTTPS://example.com/whatever?q=1");
  assert.equal(d.kind, "allowed");
  assert.equal(d.origin, "https://example.com");

  const reg2 = createSiteAuthorizations();
  reg2.grant("https://example.com:443", GRANT_KIND.SITE);
  assert.equal(reg2.decisionFor("https://example.com:443/path").kind, "allowed");
  assert.equal(reg2.decisionFor("https://example.com").kind, "allowed");
});

test("reject non-http(s) origins and unparseable URLs (#124)", () => {
  const reg = createSiteAuthorizations();
  assert.throws(() => reg.grant("file:///etc/passwd", GRANT_KIND.SITE), /valid http\(s\) origin/);
  assert.throws(
    () => reg.grant("chrome-extension://abcd/popup.html", GRANT_KIND.SITE),
    /valid http\(s\) origin/,
  );
  assert.throws(() => reg.grant(null, GRANT_KIND.SITE), /valid http\(s\) origin/);
  assert.throws(() => reg.grant("", GRANT_KIND.SITE), /valid http\(s\) origin/);
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
  assert.equal(reg.decisionFor("https://blocked.example.com/").kind, "denied");
  assert.equal(reg.decisionFor("https://blocked.example.com").reason, "origin explicitly denied");
  reg.grant("https://blocked.example.com", GRANT_KIND.SITE);
  assert.equal(reg.decisionFor("https://blocked.example.com/").kind, "allowed");
});

test("ONCE grant is consumed by the first dispatch and blocks subsequent ones (#124)", () => {
  const reg = createSiteAuthorizations();
  reg.grant("https://once.example.com", GRANT_KIND.ONCE);
  const first = reg.decisionFor("https://once.example.com/");
  assert.equal(first.kind, "allowed");
  assert.equal(first.grantKind, GRANT_KIND.ONCE);
  assert.equal(reg.consumeOnce("https://once.example.com/"), true);
  const second = reg.decisionFor("https://once.example.com/");
  assert.equal(second.kind, "denied");
  assert.equal(second.reason, "once grant already consumed");
  assert.equal(reg.consumeOnce("https://once.example.com/"), false);
});

test("revoke removes both grants and denials and is idempotent (#124)", () => {
  const reg = createSiteAuthorizations();
  reg.grant("https://a.example.com", GRANT_KIND.SITE);
  reg.deny("https://b.example.com");
  assert.equal(reg.revoke("https://a.example.com"), true);
  assert.equal(reg.revoke("https://b.example.com"), true);
  assert.equal(reg.revoke("https://never-seen.example.com"), false);
  assert.equal(reg.decisionFor("https://a.example.com/").kind, "unknown");
  assert.equal(reg.decisionFor("https://b.example.com/").kind, "unknown");
});

test("deny removes a prior grant to avoid implicit bypass (#124)", () => {
  const reg = createSiteAuthorizations();
  reg.grant("https://flip.example.com", GRANT_KIND.SITE);
  assert.equal(reg.decisionFor("https://flip.example.com/").kind, "allowed");
  reg.deny("https://flip.example.com");
  assert.equal(reg.decisionFor("https://flip.example.com/").kind, "denied");
});

test("snapshot round-trips through JSON, audit is bounded, onceUsed serialised (#124)", async () => {
  const reg = createSiteAuthorizations({ now: deterministicNowFactory() });
  reg.grant("https://s.example.com", GRANT_KIND.SITE);
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
  assert.equal(json.audit.length, 4);
  assert.equal(json.audit[0].kind, "grant");
  assert.equal(json.audit[3].kind, "deny");

  const reg2 = createSiteAuthorizations({ now: deterministicNowFactory(1), auditLimit: 3 });
  for (const origin of ["https://a", "https://b", "https://c", "https://d"]) {
    reg2.grant(origin, GRANT_KIND.SITE);
  }
  assert.equal(reg2.getAudit().length, 3);
  assert.deepEqual(reg2.getAudit().map((e) => e.kind), ["grant", "grant", "grant"]);
});

test("storage key is exported and matches the on-disk contract (#124)", () => {
  assert.equal(STORAGE_KEY_EXPORT, "orchordsSiteAuthorizations");
});

test("popup.js wires site authorization with allow-once and persistent allow-for-site controls (#124)", async () => {
  const [popupHtml, popupJs] = await Promise.all([
    readFile(popupHtmlPath, "utf8"),
    readFile(popupJsPath, "utf8"),
  ]);
  for (const action of ["allow_once", "allow_for_site", "deny_site", "revoke_site"]) {
    assert.ok(popupJs.includes(action), `popup.js must reference user-action kind "${action}"`);
  }
  assert.equal(popupJs.includes("allow_for_session"), false);
  assert.match(popupHtml, /id="site-allow-site"[^>]*>Allow for site<\/button>/);
  assert.equal(popupHtml.includes("Allow for session"), false);
  assert.match(popupJs, /site-authorizations\.js/);
});

test("service-worker persists durable site grants and discards legacy session grants (#124)", async () => {
  const sw = await readFile(serviceWorkerPath, "utf8");
  assert.match(sw, /site-authorizations\.js/);
  assert.match(sw, /SITE_AUTHZ_STORAGE_KEY|orchordsSiteAuthorizations/);
  for (const action of ["allow_once", "allow_for_site", "deny_site", "revoke_site"]) {
    assert.ok(sw.includes(action), `service-worker.js must handle user-action "${action}"`);
  }
  assert.equal(sw.includes('case "allow_for_session"'), false);
  assert.match(sw, /siteAuthorizations\.grant\(origin, GRANT_KIND\.SITE\)/);
  assert.match(sw, /siteAuthorizations\.durableSnapshot\(\)/);
  assert.match(sw, /entry\?\.kind !== GRANT_KIND\.SESSION/);
});
