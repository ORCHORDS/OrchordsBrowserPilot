// Side-panel session inspector (#128).
//
// The side panel mirrors the popup's control-state snapshot but is laid
// out for a wider, persistent inspector surface (live activity timeline,
// recent envelopes, registered origins, doctor output). It is read-only:
// it never calls a privileged API and never dispatches a user-action
// other than a passive `snapshot` request.
//
// The actual `chrome.sidePanel` API call lives in the service worker
// (the popup registers it once on install); the renderer here is pure
// data-in / DOM-out so it is unit-testable without a browser.

const STATE_LABEL = {
  disconnected: "Disconnected",
  "connected-idle": "Connected · idle",
  observing: "Observing",
  controlling: "Controlling",
  "approval-required": "Approval required",
  "human-control": "Human control",
  error: "Error",
};

function escapeText(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderSidePanel(snapshot, documentLike) {
  const doc = documentLike ?? (typeof document !== "undefined" ? document : null);
  if (!doc || typeof doc.createElement !== "function") {
    throw new Error("renderSidePanel requires a document-like object");
  }
  const root = doc.getElementById("side-panel-root") ?? doc.body;
  root.replaceChildren();

  const state = snapshot?.state ?? "disconnected";
  const heading = doc.createElement("h1");
  heading.textContent = `Orchords Web Pilot · ${STATE_LABEL[state] ?? state}`;
  root.appendChild(heading);

  const audit = doc.createElement("section");
  audit.dataset.section = "audit";
  const h2 = doc.createElement("h2");
  h2.textContent = "Audit timeline";
  audit.appendChild(h2);
  const list = doc.createElement("ol");
  for (const entry of (snapshot?.audit ?? []).slice(-30).reverse()) {
    const li = doc.createElement("li");
    li.dataset.actor = entry.actor ?? "system";
    li.textContent = `${new Date(entry.at).toISOString().slice(11, 19)} ${entry.from ?? "—"} → ${entry.to ?? "—"}`;
    list.appendChild(li);
  }
  audit.appendChild(list);
  root.appendChild(audit);

  const reg = doc.createElement("section");
  reg.dataset.section = "registry";
  const h3 = doc.createElement("h2");
  h3.textContent = "Registered origins";
  reg.appendChild(h3);
  const ul = doc.createElement("ul");
  for (const grant of snapshot?.siteAuthorizations?.grants ?? []) {
    const li = doc.createElement("li");
    li.textContent = `${escapeText(grant.origin)} — ${escapeText(grant.kind)}`;
    ul.appendChild(li);
  }
  reg.appendChild(ul);
  const denials = doc.createElement("ul");
  for (const origin of snapshot?.siteAuthorizations?.denials ?? []) {
    const li = doc.createElement("li");
    li.textContent = `${escapeText(origin)} — denied`;
    denials.appendChild(li);
  }
  reg.appendChild(denials);
  root.appendChild(reg);

  const doctorSection = doc.createElement("section");
  doctorSection.dataset.section = "doctor";
  const h4 = doc.createElement("h2");
  h4.textContent = "Connection doctor";
  doctorSection.appendChild(h4);
  const doctor = snapshot?.doctor;
  doctorSection.dataset.severity = doctor?.severity ?? "ok";
  const summary = doc.createElement("p");
  summary.textContent = doctor?.issues?.length
    ? `${doctor.issues.length} issue${doctor.issues.length === 1 ? "" : "s"} detected`
    : "No issues.";
  doctorSection.appendChild(summary);
  root.appendChild(doctorSection);

  return { rendered: true, auditCount: (snapshot?.audit ?? []).length };
}

export function createSidePanelController({ runtime, documentLike, refreshIntervalMs = 1_500 } = {}) {
  if (!runtime?.sendMessage) throw new Error("createSidePanelController requires chrome.runtime");
  const doc = documentLike ?? (typeof document !== "undefined" ? document : null);
  if (!doc) throw new Error("createSidePanelController requires a document-like object");
  let timer = null;

  async function pull() {
    try {
      await runtime.sendMessage({ kind: "user-action", action: "snapshot" });
    } catch {
      // popup may be closed; ignore
    }
  }

  function start() {
    stop();
    void pull();
    timer = setInterval(pull, Math.max(250, Math.trunc(refreshIntervalMs)));
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function bind(messageListener) {
    if (typeof messageListener !== "function") {
      throw new Error("bind requires a function");
    }
    runtime.onMessage?.addListener?.(messageListener);
  }

  function render(snapshot) {
    return renderSidePanel(snapshot, doc);
  }

  return { start, stop, pull, bind, render };
}
