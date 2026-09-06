// Extension popup controller (#125 / #124 / #129).
//
// Runs in an extension_page context with the manifest's extension_pages CSP
// ('self' only). It MUST NOT trust any data that originated from page
// content; only chrome.runtime messages from the privileged service worker
// are authoritative. Every user click dispatches a typed message back to
// the service worker, which is the sole writer of the canonical control
// state machine, the site authorization registry, settings, onboarding
// state and the connection-doctor report.

import { GRANT_KIND } from "./site-authorizations.js";
import { ONBOARDING_STAGES } from "./onboarding.js";

const STATE_LABEL = {
  disconnected: "Disconnected",
  "connected-idle": "Connected · idle",
  observing: "Observing",
  controlling: "Controlling",
  "approval-required": "Approval required",
  "human-control": "Human control",
  error: "Error",
};

const DECISION_LABEL = {
  allowed: "Active grant for this origin.",
  denied: "Origin is denied.",
  unknown: "No grant for this origin.",
};

const DOCTOR_SEVERITY_LABEL = {
  blocking: "Blocking issues found.",
  error: "Errors detected.",
  warning: "Warnings detected.",
  info: "Advisory information.",
  ok: "No issues.",
};

const elements = {
  stateLine: document.getElementById("state-line"),
  stateLabel: document.getElementById("state-label"),
  stateMonotonic: document.getElementById("state-monotonic"),
  auditList: document.getElementById("audit-list"),
  approvalSummary: document.getElementById("approval-summary"),
  approvalTool: document.getElementById("approval-tool"),
  approvalOrigin: document.getElementById("approval-origin"),
  approvalRisk: document.getElementById("approval-risk"),
  approvalEnvelope: document.getElementById("approval-envelope"),
  siteTarget: document.getElementById("site-target"),
  siteDecision: document.getElementById("site-decision"),
  siteAllowOnce: document.getElementById("site-allow-once"),
  siteAllowSite: document.getElementById("site-allow-site"),
  siteDenySite: document.getElementById("site-deny-site"),
  siteRevokeSite: document.getElementById("site-revoke-site"),
  siteGrants: document.getElementById("site-grants"),
  siteDenials: document.getElementById("site-denials"),
  onboardingSection: document.getElementById("onboarding"),
  onboardingStages: document.getElementById("onboarding-stages"),
  onboardingStatus: document.getElementById("onboarding-status"),
  onboardingAdvance: document.getElementById("onboarding-advance"),
  onboardingRestart: document.getElementById("onboarding-restart"),
  doctorSection: document.getElementById("doctor"),
  doctorSummary: document.getElementById("doctor-summary"),
  doctorIssues: document.getElementById("doctor-issues"),
  doctorRecheck: document.getElementById("doctor-recheck"),
  settingsDensity: document.getElementById("settings-density"),
  settingsStartup: document.getElementById("settings-startup"),
  settingsDiagnostics: document.getElementById("settings-diagnostics"),
  settingsSave: document.getElementById("settings-save"),
  settingsResetPairing: document.getElementById("settings-reset-pairing"),
  buttons: {
    pause: document.getElementById("action-pause"),
    stop: document.getElementById("action-stop"),
    disconnect: document.getElementById("action-disconnect"),
    takeover: document.getElementById("action-takeover"),
    resume: document.getElementById("action-resume"),
    approve: document.getElementById("action-approve"),
    deny: document.getElementById("action-deny"),
  },
};

let lastRegistry = { grants: [], denials: [], onceUsed: [] };
let lastSettings = null;
let lastOnboarding = null;

function renderAudit(audit) {
  elements.auditList.replaceChildren();
  for (const entry of audit.slice(-12).reverse()) {
    const li = document.createElement("li");
    li.dataset.actor = entry.actor ?? "system";
    const time = new Date(entry.at).toISOString().slice(11, 19);
    li.textContent = `${time} ${entry.from ?? "—"} → ${entry.to ?? "—"} (${entry.actor ?? "system"}${entry.reason ? `: ${entry.reason}` : ""})`;
    elements.auditList.appendChild(li);
  }
}

function renderRegistry(registry) {
  lastRegistry = registry ?? lastRegistry;
  elements.siteGrants.replaceChildren();
  for (const entry of lastRegistry.grants ?? []) {
    const li = document.createElement("li");
    li.textContent = `${entry.origin} — ${entry.kind}`;
    elements.siteGrants.appendChild(li);
  }
  elements.siteDenials.replaceChildren();
  for (const origin of lastRegistry.denials ?? []) {
    const li = document.createElement("li");
    li.textContent = `${origin} — denied`;
    elements.siteDenials.appendChild(li);
  }
  refreshDecision();
}

function renderSettings(settings) {
  lastSettings = settings ?? lastSettings;
  if (!lastSettings) return;
  elements.settingsDensity.value = lastSettings.interfaceDensity ?? "default";
  elements.settingsStartup.value = lastSettings.startupBehavior ?? "remember";
  elements.settingsDiagnostics.checked = Boolean(lastSettings.diagnosticsOptIn);
}

function renderOnboarding(onboarding) {
  lastOnboarding = onboarding ?? lastOnboarding;
  if (!lastOnboarding) return;
  const stage = lastOnboarding.stage ?? ONBOARDING_STAGES.UNKNOWN;
  elements.onboardingSection.dataset.stage = stage;
  elements.onboardingStatus.textContent =
    stage === ONBOARDING_STAGES.READY
      ? "Onboarding complete. You are ready to control the browser."
      : `Stage: ${stage}`;
  const items = elements.onboardingStages.querySelectorAll("li");
  items.forEach((li) => {
    li.dataset.done = lastOnboarding.completed.includes(li.dataset.stage)
      ? "true"
      : "false";
    li.dataset.current = li.dataset.stage === stage ? "true" : "false";
  });
  elements.onboardingAdvance.disabled = stage === ONBOARDING_STAGES.READY;
}

function renderDoctor(doctor) {
  const severity = doctor?.severity ?? "ok";
  elements.doctorSection.dataset.severity = severity;
  elements.doctorSummary.textContent =
    DOCTOR_SEVERITY_LABEL[severity] ?? DOCTOR_SEVERITY_LABEL.ok;
  elements.doctorIssues.replaceChildren();
  for (const issue of doctor?.issues ?? []) {
    const li = document.createElement("li");
    li.dataset.severity = issue.severity;
    const title = document.createElement("strong");
    title.textContent = `${issue.code} — ${issue.severity}`;
    li.appendChild(title);
    const msg = document.createElement("span");
    msg.textContent = ` ${issue.message}`;
    li.appendChild(msg);
    const fix = document.createElement("p");
    fix.textContent = `Fix: ${issue.fix}`;
    li.appendChild(fix);
    elements.doctorIssues.appendChild(li);
  }
}

function refreshDecision() {
  const target = elements.siteTarget.value.trim();
  const valid = /^https?:\/\/[a-z0-9.\-]+(?::\d+)?$/i.test(target);
  const decision = valid
    ? computeLocalDecision(target.toLowerCase())
    : { kind: "unknown", reason: "origin not parseable" };
  elements.siteDecision.dataset.decision = decision.kind;
  elements.siteDecision.textContent = `${DECISION_LABEL[decision.kind] ?? decision.reason}`;

  elements.siteAllowOnce.disabled = !valid;
  elements.siteAllowSite.disabled = !valid;
  elements.siteDenySite.disabled = !valid;
  elements.siteRevokeSite.disabled =
    !valid ||
    (!lastRegistry.grants.some((g) => g.origin === target.toLowerCase()) &&
      !lastRegistry.denials.includes(target.toLowerCase()));
}

function computeLocalDecision(origin) {
  if (lastRegistry.denials.includes(origin)) {
    return { kind: "denied", reason: "origin explicitly denied" };
  }
  const grant = lastRegistry.grants.find((g) => g.origin === origin);
  if (!grant) return { kind: "unknown", reason: "no user grant for origin" };
  if (grant.kind === GRANT_KIND.ONCE && lastRegistry.onceUsed?.includes(origin)) {
    return { kind: "denied", reason: "once grant already consumed" };
  }
  return { kind: "allowed", reason: `${grant.kind} grant` };
}

function renderState(snapshot) {
  const state = snapshot?.state ?? "disconnected";
  elements.stateLine.dataset.state = state;
  elements.stateLabel.textContent = STATE_LABEL[state] ?? state;
  elements.stateMonotonic.textContent = `#${snapshot?.monotonic ?? 0}`;

  const inFlight =
    state === "observing" ||
    state === "controlling" ||
    state === "approval-required" ||
    state === "human-control" ||
    state === "error";

  elements.buttons.pause.disabled = !inFlight || state === "human-control";
  elements.buttons.stop.disabled = state === "disconnected";
  elements.buttons.disconnect.disabled = state === "disconnected";
  elements.buttons.takeover.disabled = state === "disconnected";
  elements.buttons.resume.disabled = state !== "human-control";

  const needsApproval = state === "approval-required";
  elements.buttons.approve.hidden = !needsApproval;
  elements.buttons.deny.hidden = !needsApproval;
  elements.approvalSummary.hidden = !needsApproval;
  if (needsApproval && snapshot?.pendingApproval) {
    elements.approvalTool.textContent = snapshot.pendingApproval.tool ?? "—";
    elements.approvalOrigin.textContent = snapshot.pendingApproval.origin ?? "—";
    elements.approvalRisk.textContent = snapshot.pendingApproval.risk ?? "—";
    elements.approvalEnvelope.textContent = snapshot.pendingApproval.envelopeId
      ? `Envelope ${snapshot.pendingApproval.envelopeId}`
      : "";
  }

  if (snapshot?.siteAuthorizations) renderRegistry(snapshot.siteAuthorizations);
  if (snapshot?.settings) renderSettings(snapshot.settings);
  if (snapshot?.onboarding) renderOnboarding(snapshot.onboarding);
  if (snapshot?.doctor) renderDoctor(snapshot.doctor);
  renderAudit(snapshot?.audit ?? []);
}

function dispatch(action, payload = undefined) {
  const message = { kind: "user-action", action };
  if (payload !== undefined) message.payload = payload;
  chrome.runtime.sendMessage(message).catch((error) => {
    console.warn(`[Orchords Web Pilot] popup dispatch failed: ${String(error?.message ?? error)}`);
  });
}

for (const [name, button] of Object.entries(elements.buttons)) {
  button.addEventListener("click", () => dispatch(name));
}

elements.siteTarget.addEventListener("input", refreshDecision);
elements.siteAllowOnce.addEventListener("click", () => {
  dispatch("allow_once", { origin: elements.siteTarget.value.trim() });
});
elements.siteAllowSite.addEventListener("click", () => {
  dispatch("allow_for_site", { origin: elements.siteTarget.value.trim() });
});
elements.siteDenySite.addEventListener("click", () => {
  dispatch("deny_site", { origin: elements.siteTarget.value.trim() });
});
elements.siteRevokeSite.addEventListener("click", () => {
  dispatch("revoke_site", { origin: elements.siteTarget.value.trim() });
});

elements.onboardingAdvance.addEventListener("click", () => dispatch("advance_onboarding"));
elements.onboardingRestart.addEventListener("click", () => dispatch("reset_onboarding"));

elements.doctorRecheck.addEventListener("click", () => dispatch("run_doctor"));

elements.settingsSave.addEventListener("click", () => {
  dispatch("set_settings", {
    interfaceDensity: elements.settingsDensity.value,
    startupBehavior: elements.settingsStartup.value,
    diagnosticsOptIn: elements.settingsDiagnostics.checked,
  });
});
elements.settingsResetPairing.addEventListener("click", () => dispatch("reset_pairing"));

chrome.runtime.onMessage.addListener((message, _sender, _sendResponse) => {
  if (!message || message.kind !== "control-state:update") return;
  renderState(message.snapshot);
});

chrome.runtime.sendMessage({ kind: "user-action", action: "snapshot" }).catch(() => {});
