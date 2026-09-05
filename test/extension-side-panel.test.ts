import assert from "node:assert/strict";
import test from "node:test";

import { renderSidePanel } from "../extension/side-panel.js";

function fakeDocument() {
  function makeEl() {
    return {
      children: [],
      dataset: {},
      _text: "",
      get textContent() {
        return this._text;
      },
      set textContent(value) {
        this._text = String(value);
      },
      appendChild(child) {
        child.parent = this;
        this.children.push(child);
        return child;
      },
      replaceChildren(...newChildren) {
        for (const c of this.children) c.parent = null;
        this.children = newChildren;
        for (const c of this.children) c.parent = this;
      },
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

test("renderSidePanel writes a heading + audit + registry + doctor (#128)", () => {
  const doc = fakeDocument();
  const result = renderSidePanel({
    state: "controlling",
    audit: [
      { at: 1_700_000_000_000, from: "connected-idle", to: "controlling", actor: "user" },
    ],
    siteAuthorizations: {
      grants: [{ origin: "https://example.com", kind: "session" }],
      denials: ["https://blocked.example"],
    },
    doctor: { severity: "ok", issues: [] },
  }, doc);
  assert.equal(result.rendered, true);
  assert.equal(doc.body.children.length, 4);
  const [heading, audit, registry, doctor] = doc.body.children;
  assert.match(heading.textContent, /Controlling/);
  assert.equal(audit.dataset.section, "audit");
  assert.equal(audit.children[1].children.length, 1);
  assert.equal(registry.dataset.section, "registry");
  assert.equal(doctor.dataset.section, "doctor");
  assert.equal(doctor.dataset.severity, "ok");
});

test("renderSidePanel escapes untrusted origin values (#128)", () => {
  const doc = fakeDocument();
  renderSidePanel({
    state: "disconnected",
    siteAuthorizations: {
      grants: [{ origin: 'https://evil"><script>alert(1)</script>', kind: "once" }],
      denials: [],
    },
  }, doc);
  // body.children: [heading, audit, registry, doctor]
  const registry = doc.body.children[2];
  // registry.children: [h3, ul(grants), ul(denials)]
  const grantsList = registry.children[1];
  const grantItem = grantsList.children[0];
  // The renderer escapes angle brackets before assigning to textContent
  // so a malicious origin cannot inject HTML or script via the registry.
  assert.doesNotMatch(grantItem.textContent, /<script>/);
  assert.match(grantItem.textContent, /&lt;script&gt;/);
});

test("renderSidePanel defaults to disconnected when snapshot is missing (#128)", () => {
  const doc = fakeDocument();
  const result = renderSidePanel({}, doc);
  assert.equal(result.rendered, true);
  assert.match(doc.body.children[0].textContent, /Disconnected/);
  assert.equal(doc.body.children[1].children[1].children.length, 0);
});
