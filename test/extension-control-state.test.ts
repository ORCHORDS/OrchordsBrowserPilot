import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const controlStateUrl = pathToFileURL(
  path.join(repoRoot, "extension", "control-state.js"),
).href;
const popupHtmlPath = path.join(repoRoot, "extension", "popup.html");
const popupJsPath = path.join(repoRoot, "extension", "popup.js");

const { ACTOR, CONTROL_ACTIONS, CONTROL_STATES, createControlState, AUDIT_LIMIT_EXPORT } =
  await import(controlStateUrl);

function deterministicNowFactory(stepMs = 1_000) {
  let t = 1_700_000_000_000;
  return () => {
    const now = t;
    t += stepMs;
    return now;
  };
}

test("control-state enumerates the seven states (#125)", () => {
  assert.deepEqual(
    new Set(Object.values(CONTROL_STATES)),
    new Set([
      "disconnected",
      "connected-idle",
      "observing",
      "controlling",
      "approval-required",
      "human-control",
      "error",
    ]),
  );
});

test("control-state enumerates the seven user actions and rejects unknown actors", () => {
  assert.deepEqual(
    new Set(Object.values(CONTROL_ACTIONS)),
    new Set([
      "pause",
      "stop",
      "disconnect",
      "takeover",
      "resume",
      "approve",
      "deny",
    ]),
  );
  const sm = createControlState({ now: deterministicNowFactory() });
  assert.throws(
    () => sm.apply({ type: "bridge.connected", actor: "page" }),
    /actor is invalid/,
  );
  assert.throws(() => sm.apply({ type: "nonsense" }), /unknown control-state event type/);
  assert.throws(() => sm.apply({ type: 5 }), /event type is required/);
});

test("control-state disallows any transition that the matrix forbids (#125)", () => {
  const sm = createControlState({ now: deterministicNowFactory() });
  // Human-control cannot be entered directly from disconnected.
  assert.throws(() => sm.apply({ type: CONTROL_ACTIONS.TAKEOVER, actor: ACTOR.USER }));
  // Resume cannot be invoked from disconnected.
  assert.throws(() => sm.apply({ type: CONTROL_ACTIONS.RESUME, actor: ACTOR.USER }));
  // Approve/Deny can only be invoked from approval-required.
  assert.throws(() => sm.apply({ type: CONTROL_ACTIONS.APPROVE, actor: ACTOR.USER }));
  assert.throws(() => sm.apply({ type: CONTROL_ACTIONS.DENY, actor: ACTOR.USER }));
  // Pause is refused from disconnected / human-control.
  assert.throws(() => sm.apply({ type: CONTROL_ACTIONS.PAUSE, actor: ACTOR.USER }));
});

test("control-state follows a full happy-path lifecycle and records audit entries (#125)", () => {
  const sm = createControlState({ now: deterministicNowFactory(2) });

  let result = sm.apply({ type: "bridge.connected", actor: ACTOR.SYSTEM });
  assert.equal(result.state, CONTROL_STATES.CONNECTED_IDLE);

  result = sm.apply({ type: "bridge.controlling", actor: ACTOR.SYSTEM, reason: "click button" });
  assert.equal(result.state, CONTROL_STATES.CONTROLLING);

  result = sm.apply({ type: "bridge.idle", actor: ACTOR.SYSTEM, reason: "queue drained" });
  assert.equal(result.state, CONTROL_STATES.CONNECTED_IDLE);

  result = sm.apply({ type: "bridge.observing", actor: ACTOR.SYSTEM });
  assert.equal(result.state, CONTROL_STATES.OBSERVING);

  result = sm.apply({ type: "bridge.disconnected", actor: ACTOR.SYSTEM });
  assert.equal(result.state, CONTROL_STATES.DISCONNECTED);

  const snap = sm.snapshot();
  // 5 transitions ⇒ monotonic = 5, audit length = 5.
  assert.equal(snap.monotonic, 5);
  assert.equal(snap.audit.length, 5);
  for (let i = 0; i < snap.audit.length; i += 1) {
    assert.equal(snap.audit[i].monotonic, i + 1);
    assert.equal(typeof snap.audit[i].at, "number");
    assert.equal(typeof snap.audit[i].from, "string");
    assert.equal(typeof snap.audit[i].to, "string");
    assert.equal(typeof snap.audit[i].reason, "string");
  }
  assert.equal(snap.audit[0].from, CONTROL_STATES.DISCONNECTED);
  assert.equal(snap.audit[0].to, CONTROL_STATES.CONNECTED_IDLE);
  assert.equal(snap.audit.at(-1).to, CONTROL_STATES.DISCONNECTED);
});

test("control-state takeover invalidates every stale approval (#125)", () => {
  const sm = createControlState({
    now: deterministicNowFactory(3),
    invalidatedApprovals: ["approval-1", "approval-2"],
  });

  sm.apply({ type: "bridge.connected", actor: ACTOR.SYSTEM });
  sm.apply({ type: "bridge.controlling", actor: ACTOR.SYSTEM });
  // Even pre-existing approvals are invalidated when the user takes over.
  const result = sm.apply({ type: CONTROL_ACTIONS.TAKEOVER, actor: ACTOR.USER });
  assert.equal(result.state, CONTROL_STATES.HUMAN_CONTROL);
  assert.equal(sm.isApprovalValid("approval-1"), false);
  assert.equal(sm.isApprovalValid("approval-2"), false);
  // Approval ids that are not present in the invalidation set are treated as
  // still-valid (the bridge dispatches them by id, so unknown ids mean the
  // approval was never issued). However, empty / non-string ids are
  // strictly rejected — the caller has no proof the user ever issued such
  // an approval.
  assert.equal(sm.isApprovalValid("approval-3"), true);
  assert.equal(sm.isApprovalValid(undefined), false);
  assert.equal(sm.isApprovalValid(""), false);

  // Resume returns to idle; approvals remain invalid until a new one is issued.
  sm.apply({ type: CONTROL_ACTIONS.RESUME, actor: ACTOR.USER });
  assert.equal(sm.state, CONTROL_STATES.CONNECTED_IDLE);
  assert.equal(sm.isApprovalValid("approval-1"), false);

  // Bridge can invalidate a fresh approval explicitly.
  assert.equal(sm.invalidateApproval("approval-4"), true);
  assert.equal(sm.isApprovalValid("approval-4"), false);
  assert.equal(sm.invalidateApproval("approval-4"), false, "invalidateApproval is idempotent");
});

test("control-state pause invalidates approvals and is refused from idle / disconnected", () => {
  const sm = createControlState({
    now: deterministicNowFactory(),
    invalidatedApprovals: ["pre-stale"],
  });
  sm.apply({ type: "bridge.connected", actor: ACTOR.SYSTEM });
  sm.apply({ type: "bridge.controlling", actor: ACTOR.SYSTEM });

  const pause = sm.apply({ type: CONTROL_ACTIONS.PAUSE, actor: ACTOR.USER, reason: "user paused" });
  assert.equal(pause.state, CONTROL_STATES.CONNECTED_IDLE);
  assert.equal(sm.isApprovalValid("pre-stale"), false);

  // Pause from idle is a no-op, not an error.
  const noop = sm.apply({ type: CONTROL_ACTIONS.PAUSE, actor: ACTOR.USER });
  assert.equal(noop.changed, false);
  assert.equal(noop.state, CONTROL_STATES.CONNECTED_IDLE);

  // Pause from human-control is rejected.
  sm.apply({ type: CONTROL_ACTIONS.TAKEOVER, actor: ACTOR.USER });
  assert.throws(() => sm.apply({ type: CONTROL_ACTIONS.PAUSE, actor: ACTOR.USER }));
});

test("control-state audit log is replay-safe, monotonic, and capped (#125)", () => {
  const limit = AUDIT_LIMIT_EXPORT;
  const total = limit + 5;
  const sm = createControlState({
    now: deterministicNowFactory(1),
  });
  sm.apply({ type: "bridge.connected", actor: ACTOR.SYSTEM });
  for (let i = 0; i < total; i += 1) {
    sm.apply({ type: "bridge.observing", actor: ACTOR.SYSTEM });
    sm.apply({ type: "bridge.idle", actor: ACTOR.SYSTEM });
  }
  const snap = sm.snapshot();
  assert.equal(snap.audit.length, limit, "audit log is capped at the configured limit");
  // The monotonic counter must remain continuous (no gaps, no rewrites).
  for (let i = 0; i < snap.audit.length; i += 1) {
    assert.equal(snap.audit[i].monotonic, snap.monotonic - snap.audit.length + i + 1);
  }
});

test("control-state approval-required → approve / deny state transitions (#125)", () => {
  const sm = createControlState({ now: deterministicNowFactory() });
  sm.apply({ type: "bridge.connected", actor: ACTOR.SYSTEM });
  sm.apply({ type: "bridge.controlling", actor: ACTOR.SYSTEM });
  sm.apply({ type: "bridge.approval_required", actor: ACTOR.SYSTEM, reason: "high-impact op" });
  assert.equal(sm.state, CONTROL_STATES.APPROVAL_REQUIRED);

  sm.apply({ type: CONTROL_ACTIONS.DENY, actor: ACTOR.USER });
  assert.equal(sm.state, CONTROL_STATES.CONNECTED_IDLE);

  // Re-request approval then approve.
  sm.apply({ type: "bridge.approval_required", actor: ACTOR.SYSTEM });
  assert.equal(sm.state, CONTROL_STATES.APPROVAL_REQUIRED);
  const approve = sm.apply({ type: CONTROL_ACTIONS.APPROVE, actor: ACTOR.USER });
  assert.equal(approve.state, CONTROL_STATES.CONTROLLING);
});

test("control-state recovery from error returns only to connected-idle or disconnected", () => {
  const sm = createControlState({ now: deterministicNowFactory() });
  sm.apply({ type: "bridge.connected", actor: ACTOR.SYSTEM });
  sm.apply({ type: "bridge.controlling", actor: ACTOR.SYSTEM });
  sm.apply({ type: "bridge.error", actor: ACTOR.SYSTEM, reason: "timeout" });
  assert.equal(sm.state, CONTROL_STATES.ERROR);
  // Direct transition back to controlling is refused.
  assert.throws(() => sm.apply({ type: "bridge.controlling", actor: ACTOR.SYSTEM }));
  sm.apply({ type: "bridge.idle", actor: ACTOR.SYSTEM });
  assert.equal(sm.state, CONTROL_STATES.CONNECTED_IDLE);
});

test("control-state badge text and color reflect the active state (#125)", () => {
  const sm = createControlState({ now: deterministicNowFactory() });
  assert.equal(sm.badgeText(), "OFF");
  assert.equal(sm.badgeColor(), "#7a7a7a");

  sm.apply({ type: "bridge.connected", actor: ACTOR.SYSTEM });
  assert.equal(sm.badgeText(), "");
  assert.equal(sm.badgeColor(), "#1f8a3b");

  sm.apply({ type: "bridge.observing", actor: ACTOR.SYSTEM });
  assert.equal(sm.badgeText(), "EYE");
  assert.equal(sm.badgeColor(), "#1f5fa8");

  sm.apply({ type: "bridge.controlling", actor: ACTOR.SYSTEM });
  assert.equal(sm.badgeText(), "ACT");
  assert.equal(sm.badgeColor(), "#b35900");
});

test("control-state idempotent events do not mutate audit or monotonic (#125)", () => {
  const sm = createControlState({ now: deterministicNowFactory() });
  sm.apply({ type: "bridge.connected", actor: ACTOR.SYSTEM });
  const before = sm.snapshot();
  // Same event fired twice while already connected-idle.
  const second = sm.apply({ type: "bridge.connected", actor: ACTOR.SYSTEM });
  assert.equal(second.changed, false);
  const after = sm.snapshot();
  assert.equal(after.monotonic, before.monotonic);
  assert.equal(after.audit.length, before.audit.length);
});

test("control-state snapshot is serializable for session storage (#125)", () => {
  const sm = createControlState({
    now: deterministicNowFactory(),
    invalidatedApprovals: ["x"],
  });
  sm.apply({ type: "bridge.connected", actor: ACTOR.SYSTEM });
  const snap = sm.snapshot();
  const round = JSON.parse(JSON.stringify(snap));
  assert.deepEqual(round, snap);
  assert.ok(Array.isArray(round.invalidatedApprovals));
});

test("service-worker routes user-action messages through control-state (#125)", async () => {
  const sw = await readFile(path.join(repoRoot, "extension", "service-worker.js"), "utf8");
  assert.match(sw, /chrome\.runtime\.onMessage\.addListener/);
  assert.match(sw, /kind === "user-action"/);
  assert.match(sw, /applyControlTransition\(/);
  assert.match(sw, /chrome\.action\.setBadgeText/);
  assert.match(sw, /chrome\.action\.setBadgeBackgroundColor/);
  assert.match(sw, /chrome\.storage\.session\.set/);
  assert.match(sw, /isTrustedSender/);
  assert.match(sw, /CONTROL_ACTIONS\.STOP/);
  assert.match(sw, /CONTROL_ACTIONS\.DISCONNECT/);
});

test("popup.html, popup.js and popup.css exist and contain the user-action surface (#125)", async () => {
  const html = await readFile(popupHtmlPath, "utf8");
  const js = await readFile(popupJsPath, "utf8");
  const css = await readFile(path.join(repoRoot, "extension", "popup.css"), "utf8");
  for (const id of [
    "state-line",
    "state-label",
    "audit-list",
    "approval-summary",
    "action-pause",
    "action-stop",
    "action-disconnect",
    "action-takeover",
    "action-resume",
    "action-approve",
    "action-deny",
  ]) {
    assert.ok(html.includes(id), `popup.html must reference #${id}`);
  }
  for (const fn of [
    "control-state:update",
    "user-action",
    "snapshot",
    "pause",
    "stop",
    "disconnect",
    "takeover",
    "resume",
    "approve",
    "deny",
  ]) {
    assert.ok(js.includes(fn), `popup.js must reference ${fn}`);
  }
  // No remote scripts/styles; CSS is bundled.
  assert.equal(/https?:\/\//.test(html), false);
  assert.equal(/<link[^>]+href=["']https?:/.test(html), false);
  assert.equal(/<script[^>]+src=["']https?:/.test(html), false);
  // popup.css is served from extension_pages ('self') and contains the
  // per-state color mapping that powers the visible badge / popup states.
  for (const selector of [
    "[data-state=\"disconnected\"]",
    "[data-state=\"connected-idle\"]",
    "[data-state=\"observing\"]",
    "[data-state=\"controlling\"]",
    "[data-state=\"approval-required\"]",
    "[data-state=\"human-control\"]",
    "[data-state=\"error\"]",
  ]) {
    assert.ok(css.includes(selector), `popup.css must style ${selector}`);
  }
});
