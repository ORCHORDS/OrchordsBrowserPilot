import assert from "node:assert/strict";
import test from "node:test";

import {
  CDP_ADAPTER_VERSION,
  CDP_DOMAIN_ALLOWLIST,
  CDP_METHOD_ALLOWLIST,
  createCdpAdapter,
} from "../extension/cdp-adapter.js";

function makeAuditLog() {
  const entries = [];
  return { entries, append: (entry) => entries.push(entry) };
}

test("CDP adapter allow-list is exported and frozen (#132)", () => {
  assert.ok(CDP_DOMAIN_ALLOWLIST.length > 0);
  assert.ok(CDP_METHOD_ALLOWLIST.length > 0);
  assert.equal(Object.isFrozen(CDP_DOMAIN_ALLOWLIST), true);
  assert.equal(Object.isFrozen(CDP_METHOD_ALLOWLIST), true);
});

test("CDP adapter plans allow-listed methods (#132)", () => {
  const adapter = createCdpAdapter();
  const result = adapter.plan({ method: "Page.navigate", params: { url: "https://example.com" } });
  assert.equal(result.ok, true);
  assert.equal(result.envelope.version, CDP_ADAPTER_VERSION);
  assert.equal(result.envelope.method, "Page.navigate");
  assert.equal(result.envelope.params.url, "https://example.com");
});

test("CDP adapter rejects methods outside the allow-list (#132)", () => {
  const adapter = createCdpAdapter();
  const result = adapter.plan({ method: "Browser.grantPermissions", params: {} });
  assert.equal(result.ok, false);
  assert.equal(result.code, "method_not_allowed");
});

test("CDP adapter rejects malformed params (#132)", () => {
  const adapter = createCdpAdapter();
  assert.equal(adapter.plan({ method: "Page.navigate", params: "nope" }).ok, false);
  assert.equal(adapter.plan({ method: "Page.navigate", params: [] }).ok, false);
});

test("CDP adapter redacts header secrets in Network.enable (#132)", () => {
  const adapter = createCdpAdapter();
  const result = adapter.plan({
    method: "Network.enable",
    params: { headers: { Authorization: "Bearer xyz", "X-Custom": "ok" } },
  });
  assert.equal(result.envelope.params.headers.Authorization, "[REDACTED]");
  assert.equal(result.envelope.params.headers["X-Custom"], "ok");
});

test("CDP adapter redacts cookie values in Network.getCookies (#132)", () => {
  const adapter = createCdpAdapter();
  const result = adapter.plan({
    method: "Network.getCookies",
    params: { cookies: [{ name: "session", value: "secret-123" }] },
  });
  assert.equal(result.envelope.params.cookies[0].name, "session");
  assert.equal(result.envelope.params.cookies[0].value, "[REDACTED]");
});

test("CDP adapter redacts Runtime.evaluate expressions (#132)", () => {
  const adapter = createCdpAdapter();
  const result = adapter.plan({
    method: "Runtime.evaluate",
    params: { expression: "document.cookie" },
  });
  assert.equal(result.envelope.params.expression, "[REDACTED]");
});

test("CDP adapter.evaluate appends a redacted audit entry (#132)", () => {
  const audit = makeAuditLog();
  const adapter = createCdpAdapter({ auditLog: audit });
  const planned = adapter.plan({
    method: "Network.enable",
    params: { headers: { Authorization: "Bearer xyz" } },
  });
  adapter.evaluate(planned.envelope);
  assert.equal(audit.entries.length, 1);
  assert.equal(audit.entries[0].method, "Network.enable");
  assert.equal(audit.entries[0].redactedArgs.headers.Authorization, "[REDACTED]");
});

test("CDP adapter.serialize emits JSON (#132)", () => {
  const adapter = createCdpAdapter();
  const planned = adapter.plan({ method: "Page.reload", params: {} });
  const text = adapter.serialize(planned.envelope);
  const parsed = JSON.parse(text);
  assert.equal(parsed.method, "Page.reload");
});
