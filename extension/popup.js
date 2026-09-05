// Extension popup controller (#125).
//
// Runs in an extension_page context with the manifest's extension_pages CSP
// ('self' only). It MUST NOT trust any data that originated from page
// content; only chrome.runtime messages from the privileged service worker
// are authoritative. Every user click dispatches a typed message back to
// the service worker, which is the sole writer of the canonical control
// state machine.

const STATE_LABEL = {
  disconnected: "Disconnected",
  "connected-idle": "Connected · idle",
  observing: "Observing",
  controlling: "Controlling",
  "approval-required": "Approval required",
  "human-control": "Human control",
  error: "Error",
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

  renderAudit(snapshot?.audit ?? []);
}

function dispatch(action) {
  chrome.runtime.sendMessage({ kind: "user-action", action }).catch((error) => {
    console.warn(`[Orchords Web Pilot] popup dispatch failed: ${String(error?.message ?? error)}`);
  });
}

for (const [name, button] of Object.entries(elements.buttons)) {
  button.addEventListener("click", () => dispatch(name));
}

chrome.runtime.onMessage.addListener((message, _sender, _sendResponse) => {
  if (!message || message.kind !== "control-state:update") return;
  renderState(message.snapshot);
});

chrome.runtime.sendMessage({ kind: "user-action", action: "snapshot" }).catch(() => {});
