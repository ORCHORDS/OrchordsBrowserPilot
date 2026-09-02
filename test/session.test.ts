import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { RefRegistry, StaleRefError } from "../src/refs.ts";
import { Session, SessionRegistry } from "../src/session.ts";

/**
 * Tests for the per-session isolation contract (issue #3) and the ref
 * registry (issue #2). These tests deliberately avoid spinning up a real
 * browser — the registry, session, and registry-of-sessions are pure data
 * containers whose behaviour is testable in isolation. End-to-end
 * Playwright behaviour is covered by the daily-build smoke workflow.
 */

describe("RefRegistry (P0 #2)", () => {
  it("returns null for unknown refs", () => {
    const r = new RefRegistry();
    assert.equal(r.get("e1"), null);
    assert.equal(r.size(), 0);
  });

  it("ingests AI-mode YAML and exposes role+name by ref", () => {
    const r = new RefRegistry();
    const yamlText = [
      "- generic [ref=e1]:",
      "  - heading \"Settings\" [level=1] [ref=e2]",
      "  - button \"Save\" [ref=e3]",
      "  - textbox \"Email\" [ref=e4]",
    ].join("\n");
    const result = r.ingest(yamlText, undefined as never);
    assert.equal(result.registered, 3);
    assert.equal(r.size(), 3);

    const save = r.get("e3");
    assert.ok(save);
    assert.equal(save!.role, "button");
    assert.equal(save!.name, "Save");

    const email = r.get("e4");
    assert.equal(email!.role, "textbox");
    assert.equal(email!.name, "Email");
  });

  it("handles the no-quoted-name shape (`- listitem [ref=N]: Item`)", () => {
    const r = new RefRegistry();
    const yamlText = [
      "- list [ref=e5]:",
      "  - listitem [ref=e6]: Item",
      "  - listitem [ref=e7]: Item",
      "  - listitem [ref=e8]: Item",
    ].join("\n");
    r.ingest(yamlText, undefined as never);
    assert.equal(r.get("e6")!.name, "Item");
    assert.equal(r.get("e7")!.name, "Item");
  });

  it("disambiguates repeated role+name tuples with a per-frame index", () => {
    const r = new RefRegistry();
    const yamlText = [
      "- list [ref=e5]:",
      "  - listitem [ref=e6]: Item",
      "  - listitem [ref=e7]: Item",
      "  - listitem [ref=e8]: Item",
    ].join("\n");
    r.ingest(yamlText, undefined as never);
    assert.equal(r.get("e6")!.index, 0);
    assert.equal(r.get("e7")!.index, 1);
    assert.equal(r.get("e8")!.index, 2);
  });

  it("clear() drops every ref", () => {
    const r = new RefRegistry();
    r.ingest("- button \"OK\" [ref=e1]", undefined as never);
    assert.equal(r.size(), 1);
    r.clear();
    assert.equal(r.size(), 0);
    assert.equal(r.get("e1"), null);
  });

  it("StaleRefError carries the offending ref key", () => {
    const err = new StaleRefError("e99");
    assert.ok(err.message.includes("e99"));
    assert.ok(err instanceof StaleRefError);
  });
});

describe("SessionRegistry (P0 #3)", () => {
  it("returns a stable Session for the same id", () => {
    const reg = new SessionRegistry();
    const a = reg.getOrCreate("client-A", id => new Session(id, fakeManager()));
    const b = reg.getOrCreate("client-A", id => new Session(id, fakeManager()));
    assert.equal(a, b);
    assert.equal(reg.size(), 1);
  });

  it("isolates sessions by id", async () => {
    const reg = new SessionRegistry();
    const a = reg.getOrCreate("client-A", id => new Session(id, fakeManager()));
    const b = reg.getOrCreate("client-B", id => new Session(id, fakeManager()));
    assert.notEqual(a, b);

    // Each session owns its own diagnostics buffer; one session's writes
    // must not show up in the other.
    a.diagnostics.onRequestFinished("https://a.test/", "GET", 200, "document");
    b.diagnostics.onRequestFinished("https://b.test/", "GET", 200, "document");

    const aNet = a.diagnostics.network(false, 100);
    const bNet = b.diagnostics.network(false, 100);
    assert.equal(aNet.length, 1);
    assert.equal(aNet[0]!.url, "https://a.test/");
    assert.equal(bNet.length, 1);
    assert.equal(bNet[0]!.url, "https://b.test/");
  });

  it("dispose() drops the session and a future getOrCreate returns a fresh one", async () => {
    const reg = new SessionRegistry();
    const a = reg.getOrCreate("client-A", id => new Session(id, fakeManager()));
    await reg.dispose("client-A");
    assert.equal(reg.size(), 0);
    const a2 = reg.getOrCreate("client-A", id => new Session(id, fakeManager()));
    assert.notEqual(a, a2);
  });

  it("sweep() removes only sessions that have exceeded idleMs", async () => {
    const reg = new SessionRegistry(10); // 10ms idle
    reg.getOrCreate("stale", id => new Session(id, fakeManager()));
    reg.getOrCreate("fresh", id => new Session(id, fakeManager()));
    // Bump "fresh" so its lastUsed is recent.
    await new Promise(r => setTimeout(r, 25));
    reg.getOrCreate("fresh", id => new Session(id, fakeManager()));
    const dropped = await reg.sweep();
    assert.equal(dropped, 1);
    assert.equal(reg.size(), 1);
  });
});

/**
 * Minimal BrowserManager stub. We never call `page()` in these tests — the
 * `Session` constructor accepts any object that satisfies the interface.
 */
function fakeManager() {
  return {
    page: async () => {
      throw new Error("not used in this test");
    },
    close: async () => undefined,
  };
}

// Silence the unused-import warning when only the StaleRefError class is
// referenced by tests above.
assert.ok(typeof StaleRefError === "function");