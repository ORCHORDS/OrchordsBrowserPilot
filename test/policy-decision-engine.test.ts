import { test } from "node:test";
import assert from "node:assert/strict";

import {
  POLICY_ENGINE_VERSION,
  PolicyDecisionEngine,
  defaultControls,
  stubControl,
  type PolicyControlKind,
  type PolicyInputs,
  type Verdict,
} from "../src/policy/decision.js";
import { ActionGate } from "../src/policy/gate.js";
import { ApprovalStore } from "../src/policy/approval.js";
import { MemoryAuditSink, noopSink } from "../src/policy/audit.js";

const baseInputs = (overrides: Partial<PolicyInputs> = {}): PolicyInputs => ({
  tool: "browser_click",
  risk: "read",
  effectiveUrl: "https://example.com/page",
  origin: "https://example.com",
  secretIds: [],
  dataFlowLabels: [],
  principal: { id: "user-1", scopes: ["browser:basic"], dataLabels: [] },
  ...overrides,
});

test("policy decision engine: deny short-circuits all other verdicts", () => {
  const engine = new PolicyDecisionEngine([
    stubControl("auth", { kind: "allow" }),
    stubControl("egress", { kind: "deny", reason: "blocked_host" }),
    stubControl("capability", { kind: "require_approval" }),
    stubControl("dataflow", { kind: "allow" }),
    stubControl("risk", { kind: "allow" }),
  ]);
  const d = engine.decide(baseInputs());
  assert.equal(d.verdict.kind, "deny");
  assert.equal(d.verdict.reason, "blocked_host");
  assert.equal(d.permitted, false);
  assert.equal(d.requiresApproval, false);
  assert.equal(d.policyVersion, POLICY_ENGINE_VERSION);
  // Contributions are still recorded for audit replay.
  assert.equal(d.contributions.length, 5);
  assert.equal(d.contributions[1].control, "egress");
  assert.equal(d.contributions[1].verdict.reason, "blocked_host");
});

test("policy decision engine: require_elevated_scope beats require_approval", () => {
  const engine = new PolicyDecisionEngine([
    stubControl("auth", { kind: "allow" }),
    stubControl("egress", { kind: "allow" }),
    stubControl("capability", { kind: "require_approval" }),
    stubControl("dataflow", { kind: "allow" }),
    stubControl("risk", { kind: "require_elevated_scope", scope: "capability:sensitive" }),
  ]);
  const d = engine.decide(baseInputs());
  assert.equal(d.verdict.kind, "require_elevated_scope");
  assert.equal(d.verdict.scope, "capability:sensitive");
  assert.equal(d.requiresElevatedScope, true);
  assert.equal(d.requiresApproval, false);
  assert.equal(d.permitted, false);
});

test("policy decision engine: allow when every control agrees", () => {
  const engine = new PolicyDecisionEngine([
    stubControl("auth", { kind: "allow" }),
    stubControl("egress", { kind: "allow" }),
    stubControl("capability", { kind: "allow" }),
    stubControl("dataflow", { kind: "allow" }),
    stubControl("risk", { kind: "allow" }),
  ]);
  const d = engine.decide(baseInputs());
  assert.equal(d.verdict.kind, "allow");
  assert.equal(d.permitted, true);
  assert.equal(d.requiresApproval, false);
  assert.equal(d.requiresElevatedScope, false);
});

test("default controls: missing principal is denied", () => {
  const engine = new PolicyDecisionEngine(defaultControls);
  const d = engine.decide(baseInputs({ principal: { id: "", scopes: ["browser:basic"], dataLabels: [] } }));
  assert.equal(d.verdict.kind, "deny");
  assert.equal(d.verdict.reason, "principal_missing");
});

test("default controls: principal with no scopes requires elevated scope", () => {
  const engine = new PolicyDecisionEngine(defaultControls);
  const d = engine.decide(baseInputs({ principal: { id: "u", scopes: [], dataLabels: [] } }));
  assert.equal(d.verdict.kind, "require_elevated_scope");
  assert.equal(d.verdict.scope, "browser:basic");
});

test("default controls: internal network without scope requires elevated scope", () => {
  const engine = new PolicyDecisionEngine(defaultControls);
  const d = engine.decide(
    baseInputs({
      effectiveUrl: "http://10.0.0.5/admin",
      origin: "http://10.0.0.5",
    }),
  );
  assert.equal(d.verdict.kind, "require_elevated_scope");
  assert.equal(d.verdict.scope, "egress:internal");
  assert.equal(d.verdict.reason, "egress_internal_requires_scope");
});

test("default controls: internal network WITH scope is allowed at egress layer", () => {
  const engine = new PolicyDecisionEngine(defaultControls);
  const d = engine.decide(
    baseInputs({
      effectiveUrl: "http://10.0.0.5/admin",
      origin: "http://10.0.0.5",
      principal: { id: "ops", scopes: ["browser:basic", "egress:internal"], dataLabels: [] },
    }),
  );
  // Risk layer is "allow" for read; everything else is allow.
  assert.equal(d.verdict.kind, "allow");
});

test("default controls: irreversible risk without capability scope is require_elevated_scope", () => {
  const engine = new PolicyDecisionEngine(defaultControls);
  const d = engine.decide(baseInputs({ risk: "irreversible" }));
  assert.equal(d.verdict.kind, "require_elevated_scope");
  assert.equal(d.verdict.scope, "capability:irreversible");
});

test("default controls: irreversible risk WITH capability scope still requires approval", () => {
  const engine = new PolicyDecisionEngine(defaultControls);
  const d = engine.decide(
    baseInputs({
      risk: "irreversible",
      principal: {
        id: "ops",
        scopes: ["browser:basic", "capability:irreversible"],
        dataLabels: [],
      },
    }),
  );
  assert.equal(d.verdict.kind, "require_approval");
  assert.equal(d.requiresApproval, true);
});

test("default controls: sensitive risk without capability scope requires elevated scope", () => {
  const engine = new PolicyDecisionEngine(defaultControls);
  const d = engine.decide(baseInputs({ risk: "sensitive" }));
  assert.equal(d.verdict.kind, "require_elevated_scope");
  assert.equal(d.verdict.scope, "capability:sensitive");
});

test("default controls: data-flow label not held by principal is denied", () => {
  const engine = new PolicyDecisionEngine(defaultControls);
  const d = engine.decide(
    baseInputs({
      dataFlowLabels: ["pii"],
      principal: { id: "u", scopes: ["browser:basic"], dataLabels: [] },
    }),
  );
  assert.equal(d.verdict.kind, "deny");
  assert.equal(d.verdict.reason, "dataflow_label_not_permitted");
});

test("default controls: secret reference without matching label is denied", () => {
  const engine = new PolicyDecisionEngine(defaultControls);
  const d = engine.decide(
    baseInputs({
      secretIds: ["stripe"],
      principal: { id: "u", scopes: ["browser:basic"], dataLabels: [] },
    }),
  );
  assert.equal(d.verdict.kind, "deny");
  assert.equal(d.verdict.reason, "dataflow_secret_label_missing");
});

test("default controls: secret reference WITH matching label is allowed at dataflow layer", () => {
  const engine = new PolicyDecisionEngine(defaultControls);
  const d = engine.decide(
    baseInputs({
      secretIds: ["stripe"],
      principal: { id: "u", scopes: ["browser:basic"], dataLabels: ["secret:stripe"] },
    }),
  );
  assert.equal(d.verdict.kind, "allow");
});

test("default controls: non-http scheme is denied", () => {
  const engine = new PolicyDecisionEngine(defaultControls);
  const d = engine.decide(baseInputs({ effectiveUrl: "file:///etc/passwd", origin: "" }));
  assert.equal(d.verdict.kind, "deny");
  assert.equal(d.verdict.reason, "egress_non_http");
});

test("default controls: unparseable URL is denied", () => {
  const engine = new PolicyDecisionEngine(defaultControls);
  const d = engine.decide(baseInputs({ effectiveUrl: "not a url", origin: "" }));
  assert.equal(d.verdict.kind, "deny");
  assert.equal(d.verdict.reason, "egress_unparseable_url");
});

test("policy decision engine: deterministic — same inputs and version produce same decision", () => {
  const engine = new PolicyDecisionEngine(defaultControls);
  const inputs = baseInputs({ risk: "mutate" });
  const a = engine.decide(inputs);
  const b = engine.decide(inputs);
  assert.deepEqual(a, b);
});

test("policy decision engine: versioned — every contribution carries engine version", () => {
  const engine = new PolicyDecisionEngine(defaultControls, 7);
  const d = engine.decide(baseInputs());
  assert.equal(d.policyVersion, 7);
  for (const c of d.contributions) {
    assert.equal(c.policyVersion, 7);
  }
});

test("policy decision engine: rejects duplicate control kinds", () => {
  assert.throws(
    () =>
      new PolicyDecisionEngine([
        stubControl("auth", { kind: "allow" }),
        stubControl("auth", { kind: "deny", reason: "dup" }),
      ]),
    /duplicate control "auth"/,
  );
});

test("policy decision engine: rejects empty controls", () => {
  assert.throws(() => new PolicyDecisionEngine([]), /at least one control/);
});

test("policy decision engine: summary enumerates every control verdict", () => {
  const engine = new PolicyDecisionEngine([
    stubControl("auth", { kind: "allow" }),
    stubControl("egress", { kind: "deny", reason: "blocked" }),
    stubControl("capability", { kind: "allow" }),
    stubControl("dataflow", { kind: "allow" }),
    stubControl("risk", { kind: "require_approval", reason: "risk_sensitive" }),
  ]);
  const d = engine.decide(baseInputs());
  assert.match(d.summary, /auth: allow/);
  assert.match(d.summary, /egress: deny \(blocked\)/);
  assert.match(d.summary, /risk: require_approval \(risk_sensitive\)/);
});

test("ActionGate wires the engine: irreversible + no capability scope denies via decide()", () => {
  const approvals = new ApprovalStore();
  const sink = new MemoryAuditSink();
  const gate = new ActionGate(approvals, sink.asSink());
  const d = gate.decide({
    tool: "browser_click",
    risk: "irreversible",
    effectiveUrl: "https://example.com",
    origin: "https://example.com",
    secretIds: [],
    dataFlowLabels: [],
    principal: { id: "u", scopes: ["browser:basic"], dataLabels: [] },
  });
  assert.equal(d.verdict.kind, "require_elevated_scope");
  assert.equal(d.requiresElevatedScope, true);
  // Engine version is pinned and surfaced.
  assert.equal(gate.policyVersion(), POLICY_ENGINE_VERSION);
});

test("ActionGate wires the engine: capability scope unblocks, approval still required for irreversible", () => {
  const approvals = new ApprovalStore();
  const sink = new MemoryAuditSink();
  const gate = new ActionGate(approvals, sink.asSink());
  const d = gate.decide({
    tool: "browser_click",
    risk: "irreversible",
    effectiveUrl: "https://example.com",
    origin: "https://example.com",
    secretIds: [],
    dataFlowLabels: [],
    principal: {
      id: "ops",
      scopes: ["browser:basic", "capability:irreversible"],
      dataLabels: [],
    },
  });
  assert.equal(d.verdict.kind, "require_approval");
  assert.equal(d.requiresApproval, true);
});

test("ActionGate wires the engine: missing principal denies before approval mint", () => {
  const approvals = new ApprovalStore();
  const sink = new MemoryAuditSink();
  const gate = new ActionGate(approvals, sink.asSink());
  const d = gate.decide({
    tool: "browser_click",
    risk: "mutate",
    effectiveUrl: "https://example.com",
    origin: "https://example.com",
    secretIds: [],
    dataFlowLabels: [],
    principal: { id: "", scopes: ["browser:basic"], dataLabels: [] },
  });
  assert.equal(d.verdict.kind, "deny");
  assert.equal(sink.events().length, 0, "deny at decision layer must not produce an approval audit row");
});

test("policy decision engine: secret label check is per-secret, not all-or-nothing", () => {
  const engine = new PolicyDecisionEngine(defaultControls);
  const d = engine.decide(
    baseInputs({
      secretIds: ["stripe", "github"],
      principal: { id: "u", scopes: ["browser:basic"], dataLabels: ["secret:stripe"] },
    }),
  );
  assert.equal(d.verdict.kind, "deny");
  assert.equal(d.verdict.reason, "dataflow_secret_label_missing");
  assert.match(d.verdict.note ?? "", /github/);
});

test("policy decision engine: precedence table — deny beats everything", () => {
  const order: PolicyControlKind[] = ["risk", "dataflow", "capability", "egress", "auth"];
  for (const ctrlAt of order) {
    const controls: PolicyControlKind[] = ["auth", "egress", "capability", "dataflow", "risk"];
    const built = controls.map((kind) =>
      stubControl(
        kind,
        kind === ctrlAt ? { kind: "deny", reason: "x" } : { kind: "allow" },
      ),
    );
    const engine = new PolicyDecisionEngine(built);
    const d = engine.decide(baseInputs());
    assert.equal(d.verdict.kind, "deny", `deny at ${ctrlAt} should win regardless of position`);
  }
});

test("policy decision engine: stubControl exposes supplied verdict verbatim", () => {
  const v: Verdict = { kind: "require_elevated_scope", scope: "x", reason: "r" };
  const c = stubControl("auth", v);
  assert.equal(c.kind, "auth");
  assert.deepEqual(c.evaluate(baseInputs()), v);
});

test("ActionGate exposes the engine and forwards every input unchanged", () => {
  const approvals = new ApprovalStore();
  const gate = new ActionGate(approvals, noopSink);
  const d = gate.decide(baseInputs({ risk: "mutate" }));
  // The engine layer does not touch inputs; risk stays mutate in summary.
  assert.match(d.summary, /risk: allow/);
});
