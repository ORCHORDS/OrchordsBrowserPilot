import assert from "node:assert/strict";
import test from "node:test";

import {
  CURRENT_SCHEMA_VERSION,
  MIGRATIONS,
  migrationPlan,
  rollbackIfUnsupported,
  runMigrations,
} from "../extension/schema-migrations.js";

test("CURRENT_SCHEMA_VERSION is a positive integer (#138)", () => {
  assert.ok(Number.isInteger(CURRENT_SCHEMA_VERSION));
  assert.ok(CURRENT_SCHEMA_VERSION >= 1);
});

test("migrationPlan handles an up-to-date state with no steps (#138)", () => {
  const plan = migrationPlan(CURRENT_SCHEMA_VERSION);
  assert.equal(plan.ok, true);
  assert.equal(plan.steps.length, 0);
});

test("migrationPlan returns the chain from a legacy version (#138)", () => {
  const plan = migrationPlan(1);
  assert.equal(plan.ok, true);
  assert.equal(plan.steps.length, 3);
  assert.deepEqual(plan.steps.map((s) => `${s.from}->${s.to}`), ["1->2", "2->3", "3->4"]);
});

test("migrationPlan rejects a future / invalid version (#138)", () => {
  assert.equal(migrationPlan(CURRENT_SCHEMA_VERSION + 1).code, "downgrade_unsupported");
  assert.equal(migrationPlan(0).code, "invalid_version");
  assert.equal(migrationPlan(-1).code, "invalid_version");
});

test("MIGRATIONS list is frozen and non-empty (#138)", () => {
  assert.equal(Object.isFrozen(MIGRATIONS), true);
  assert.ok(MIGRATIONS.length >= 1);
});

test("runMigrations upgrades v1 → v4 and preserves user data (#138)", () => {
  const state = {
    _schema: 1,
    settings: { startupBehavior: "remember" },
    siteAuthorizations: { grants: [{ origin: "https://example.com", kind: "session" }] },
  };
  const result = runMigrations(state);
  assert.equal(result.ok, true);
  assert.equal(result.state._schema, 4);
  assert.equal(result.state.settings.interfaceDensity, "default");
  assert.equal(result.state.settings.diagnosticsOptIn, false);
  assert.ok(Array.isArray(result.state.siteAuthorizations.onceUsed));
  assert.ok(Array.isArray(result.state.siteAuthorizations.audit));
  assert.deepEqual(result.applied, ["1->2", "2->3", "3->4"]);
});

test("rollbackIfUnsupported passes a supported state through (#138)", () => {
  const r = rollbackIfUnsupported({ _schema: 2, foo: 1 }, { defaults: true });
  assert.equal(r.ok, true);
  assert.equal(r.state._schema, 2);
  assert.equal(r.state.foo, 1);
  assert.equal(r.backup, undefined);
});

test("rollbackIfUnsupported rolls back an unsupported state and captures the backup (#138)", () => {
  const r = rollbackIfUnsupported({ _schema: 99, foo: "bad" }, { foo: "fresh" });
  assert.equal(r.ok, true);
  assert.equal(r.state._schema, CURRENT_SCHEMA_VERSION);
  assert.equal(r.state._rolledBack, true);
  assert.equal(r.state.foo, "fresh");
  assert.equal(r.backup._schema, 99);
});
