import {
  BridgeOutboundQueue,
  ReplayWindow,
  createBridgeCompatReport,
  createBridgeEnvelope,
  createBridgeHelloPayload,
  createBridgeWelcomePayload,
  evaluateCompatibility,
  validateBridgeEnvelope,
} from "./bridge-protocol.js";
import { createServiceWorkerLifecycle } from "./service-worker-lifecycle.js";
import { CURRENT_SCHEMA_VERSION, rollbackIfUnsupported, runMigrations } from "./schema-migrations.js";
import { createSupportBundle } from "./support-bundle.js";
import { AuthenticatedBridgeClient } from "./bridge-client.js";
import {
  acceptPairingResponse,
  createPairingHelloPayload,
  loadOrCreatePairingState,
} from "./pairing-state.js";
import {
  ACTOR,
  CONTROL_ACTIONS,
  CONTROL_STATES,
  createControlState,
} from "./control-state.js";
import {
  GRANT_KIND,
  createSiteAuthorizations,
  STORAGE_KEY_EXPORT as SITE_AUTHZ_STORAGE_KEY,
} from "./site-authorizations.js";
import { createTabAttachment } from "./tab-attachment.js";
import { createDispatchGate } from "./dispatch-gate.js";
import {
  SETTINGS_STORAGE_KEY,
  defaultSettings,
  saveSettings,
  loadSettings,
} from "./settings.js";
import {
  ONBOARDING_STORAGE_KEY,
  defaultOnboardingState,
  loadOnboardingState,
  advanceOnboarding,
  transitionOnboarding,
  persistOnboardingState,
  resetOnboarding,
} from "./onboarding.js";
import { diagnose } from "./connection-doctor.js";

const PRODUCT = "Orchords Web Pilot";
const NATIVE_HOST = "com.orchords.web_pilot";
const REPLAY_STORAGE_KEY = "nativeBridgeReplayKeys";
const CONTROL_STATE_STORAGE_KEY = "nativeBridgeControlState";

let nativePort = null;
let bridgeClient = null;
let replayWindow = new ReplayWindow();
let outboundQueue = new BridgeOutboundQueue();
let swLifecycle = null;
let pairingState;
let controlState = createControlState({ initial: CONTROL_STATES.DISCONNECTED });
let siteAuthorizations = createSiteAuthorizations();
const tabAttachment = createTabAttachment({ tabsApi: chrome.tabs });
const dispatchGate = createDispatchGate({
  registry: siteAuthorizations,
  attachment: tabAttachment,
  tabsApi: chrome.tabs,
});
let settings = defaultSettings();
let onboarding = defaultOnboardingState();
let lastBridgeError = null;
let browserInfo = null;
let coreInfo = null;
let bridgeCompat = null;

function postEnvelope(type, payload, options = {}) {
  if (!nativePort) return { ok: false, code: "native_disconnected" };
  const envelope = createBridgeEnvelope(type, payload, options);
  const result = outboundQueue.enqueue(envelope);
  if (!result.ok) return result;
  try {
    nativePort.postMessage(envelope);
    // #130 — track every outbound envelope in session storage so the
    // service worker can resume after a suspension/wakeup.
    void swLifecycle?.trackOutbound(envelope);
    return { ok: true, id: envelope.id };
  } catch (error) {
    outboundQueue.drainAll();
    return { ok: false, code: "post_failed", message: error instanceof Error ? error.message : String(error) };
  }
}

function ensureSwLifecycle() {
  if (swLifecycle) return swLifecycle;
  swLifecycle = createServiceWorkerLifecycle({
    chromeApi: chrome,
    alarmsApi: chrome.alarms,
    storageSession: chrome.storage.session,
    postEnvelope,
  });
  swLifecycle.registerAlarms();
  return swLifecycle;
}

function logLifecycle(event) {
  console.info(`[${PRODUCT}] extension ${event}`);
}

const replayReady = chrome.storage.session.get(REPLAY_STORAGE_KEY).then((stored) => {
  const keys = Array.isArray(stored?.[REPLAY_STORAGE_KEY]) ? stored[REPLAY_STORAGE_KEY] : [];
  replayWindow = new ReplayWindow(keys);
});

const pairingReady = loadOrCreatePairingState(chrome.storage.local).then((state) => {
  pairingState = state;
  return state;
});

const controlStateReady = chrome.storage.session
  .get(CONTROL_STATE_STORAGE_KEY)
  .then((stored) => {
    const candidate = stored?.[CONTROL_STATE_STORAGE_KEY];
    if (
      candidate &&
      typeof candidate === "object" &&
      Array.isArray(candidate.audit) &&
      typeof candidate.state === "string"
    ) {
      controlState = createControlState({
        initial: candidate.state,
        audit: candidate.audit,
        monotonic:
          Number.isInteger(candidate.monotonic) && candidate.monotonic >= 0
            ? candidate.monotonic
            : 0,
        invalidatedApprovals: Array.isArray(candidate.invalidatedApprovals)
          ? candidate.invalidatedApprovals
          : [],
      });
    }
    return true;
  });

const siteAuthzReady = chrome.storage.local
  .get(SITE_AUTHZ_STORAGE_KEY)
  .then((stored) => {
    const candidate = stored?.[SITE_AUTHZ_STORAGE_KEY];
    if (candidate && typeof candidate === "object") {
      const durableGrants = Array.isArray(candidate.grants)
        ? candidate.grants.filter((entry) => entry?.kind !== GRANT_KIND.SESSION)
        : [];
      siteAuthorizations = createSiteAuthorizations({
        grants: durableGrants,
        denials: candidate.denials,
        onceUsed: candidate.onceUsed,
        audit: candidate.audit,
      });
    }
    return true;
  });

const settingsReady = loadSettings(chrome.storage.local).then((s) => {
  settings = s;
  return s;
});

const onboardingReady = chrome.storage.local
  .get(ONBOARDING_STORAGE_KEY)
  .then((stored) => {
    onboarding = loadOnboardingState(stored);
    return onboarding;
  });

async function persistControlState() {
  const snap = controlState.snapshot();
  await chrome.storage.session.set({ [CONTROL_STATE_STORAGE_KEY]: snap });
  await broadcastControlState();
  await renderBadge();
}

async function persistSiteAuthorizations() {
  await chrome.storage.local.set({
    [SITE_AUTHZ_STORAGE_KEY]: siteAuthorizations.durableSnapshot(),
  });
  await broadcastControlState();
}

async function persistSettings() {
  await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: settings });
  await broadcastControlState();
}

async function persistOnboarding() {
  await persistOnboardingState(chrome.storage.local, onboarding);
  await broadcastControlState();
}

async function broadcastControlState() {
  try {
    await chrome.runtime.sendMessage({
      kind: "control-state:update",
      snapshot: composeSnapshot(),
    });
  } catch {
    // Popup may not be open; sendMessage rejects when no listener.
  }
}

function composeSnapshot() {
  return {
    ...controlState.snapshot(),
    siteAuthorizations: siteAuthorizations.snapshot(),
    settings,
    onboarding,
    doctor: doctorOutput(),
    browser: browserInfo,
    core: coreInfo,
    bridgeCompat,
    lastBridgeError,
  };
}

function doctorOutput() {
  return diagnose({
    manifestVersion: chrome.runtime.getManifest?.()?.manifest_version ?? 3,
    browser: browserInfo,
    core: coreInfo,
    pairing: pairingState?.pairing,
    lastError: lastBridgeError,
    controlState: controlState.snapshot().state,
  });
}

async function renderBadge() {
  const text = controlState.badgeText();
  const color = controlState.badgeColor();
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
}

async function rememberBridgeEnvelope(message) {
  replayWindow.add(message);
  await chrome.storage.session.set({ [REPLAY_STORAGE_KEY]: replayWindow.toJSON() });
}

async function applyControlTransition(event) {
  const result = controlState.apply(event);
  if (result.changed) await persistControlState();
  return result;
}

function applySiteAuthorization(action, payload) {
  const origin = typeof payload?.origin === "string" ? payload.origin.trim() : "";
  switch (action) {
    case "allow_once":
      siteAuthorizations.grant(origin, GRANT_KIND.ONCE);
      break;
    case "allow_for_site":
      siteAuthorizations.grant(origin, GRANT_KIND.SITE);
      break;
    case "deny_site":
      siteAuthorizations.deny(origin, "user denied");
      break;
    case "revoke_site":
      siteAuthorizations.revoke(origin, "user revoked");
      break;
    default:
      throw new Error(`unknown site-authorization action: ${String(action)}`);
  }
}

async function handleNativeMessage(message) {
  await replayReady;
  const result = validateBridgeEnvelope(message, { replay: replayWindow });
  if (!result.ok) {
    console.warn(`[${PRODUCT}] rejected native bridge envelope: ${result.code}`);
    return;
  }

  // #123 — version handshake.
  //
  // The native host announces its product version in `bridge.welcome` after
  // we send `bridge.hello`. We refuse any welcome that doesn't fall inside
  // our supported range and emit a `bridge.compat.report` envelope back so
  // the host can record the disagreement.
  if (message.type === "bridge.welcome") {
    const evaluation = evaluateCompatibility({
      hello: {
        bridgeProtocol: 1,
        extensionVersion: chrome.runtime.getManifest?.()?.version ?? "0.0.0",
      },
      welcome: message.payload,
    });
    if (!evaluation.ok) {
      console.warn(`[${PRODUCT}] rejected bridge.welcome: ${evaluation.code}`);
      postEnvelope("bridge.compat.report", createBridgeCompatReport({
        coreVersion: message.payload?.coreVersion ?? "unknown",
        extensionVersion: chrome.runtime.getManifest?.()?.version ?? "0.0.0",
      }));
      bridgeCompat = { ok: false, code: evaluation.code };
      lastBridgeError = {
        code: "EXT-BRIDGE-INCOMPATIBLE",
        message: `native host version ${message.payload?.coreVersion ?? "unknown"} not in supported range`,
        at: Date.now(),
      };
      return;
    }
    bridgeCompat = evaluation;
    coreInfo = { ...(coreInfo ?? {}), version: evaluation.coreVersion };
    logLifecycle(`native bridge compat ok core=${evaluation.coreVersion}`);
    await rememberBridgeEnvelope(message);
    return;
  }

  if (message.type === "bridge.paired" || message.type === "bridge.ready") {
    await pairingReady;
    pairingState = await acceptPairingResponse(chrome.storage.local, pairingState, message);
    if (!pairingState.pairing) throw new Error("native bridge pairing credential missing after handshake");
    bridgeClient?.disconnect("native bridge pairing replaced");
    bridgeClient = new AuthenticatedBridgeClient(nativePort, pairingState.pairing);
    await rememberBridgeEnvelope(message);
    await applyControlTransition({ type: "bridge.connected", actor: ACTOR.SYSTEM, reason: message.type });
    lastBridgeError = null;
    logLifecycle(message.type === "bridge.paired" ? "native bridge paired" : "native bridge ready");
    return;
  }

  if (!bridgeClient) throw new Error("authenticated native bridge response arrived before pairing");
  const handled = await bridgeClient.handleMessage(message);
  if (!handled) throw new Error(`unexpected authenticated native bridge response type: ${String(message?.type ?? "unknown")}`);
  await rememberBridgeEnvelope(message);
}

function connectNativeBridge() {
  if (nativePort) return nativePort;

  const port = chrome.runtime.connectNative(NATIVE_HOST);
  nativePort = port;

  port.onMessage.addListener((message) => {
    void handleNativeMessage(message).catch((error) => {
      const detail = error instanceof Error ? String(error.message) : String(error);
      console.warn(`[${PRODUCT}] rejected native bridge response: ${detail}`);
    });
  });

  port.onDisconnect.addListener(() => {
    nativePort = null;
    const reason = chrome.runtime.lastError?.message;
    bridgeClient?.disconnect(reason ?? "native bridge disconnected");
    bridgeClient = null;
    lastBridgeError = {
      code: reason ? "EXT-NATIVE-DISCONNECTED" : "EXT-NATIVE-DISCONNECTED",
      message: reason ?? "native bridge disconnected",
      at: Date.now(),
    };
    void applyControlTransition({
      type: "bridge.disconnected",
      actor: ACTOR.SYSTEM,
      reason: reason ?? "native bridge disconnected",
    });
    // #130 — schedule a reconnect on a bounded backoff schedule so the
    // service worker recovers from host restarts without user action.
    void ensureSwLifecycle().triggerReconnect({ reason: reason ?? "native bridge disconnected" });
    if (reason) {
      console.warn(`[${PRODUCT}] native bridge disconnected: ${reason}`);
    } else {
      console.warn(`[${PRODUCT}] native bridge disconnected`);
    }
  });

  void Promise.all([pairingReady, controlStateReady])
    .then(() => {
      // #123 — open with BOTH the pairing hello (existing wire format)
      // and the explicit version-handshake hello (bridge.hello with
      // product versions). Existing hosts keep working through the
      // pairing payload; newer hosts answer with a versioned welcome.
      port.postMessage(createBridgeEnvelope("bridge.hello", createPairingHelloPayload(pairingState)));
      const extensionVersion = chrome.runtime.getManifest?.()?.version ?? "0.0.0";
      postEnvelope("bridge.hello", createBridgeHelloPayload({ extensionVersion }));
    })
    .catch((error) => {
      const detail = error instanceof Error ? String(error.message) : String(error);
      console.warn(`[${PRODUCT}] native bridge pairing state unavailable: ${detail}`);
      port.disconnect();
    });

  return port;
}

chrome.runtime.onInstalled.addListener(async () => {
  logLifecycle("installed");
  // #138 — run schema migrations on every install / update.
  await runSchemaMigrations();
  ensureSwLifecycle();
  connectNativeBridge();
});

chrome.runtime.onStartup.addListener(async () => {
  logLifecycle("started");
  await runSchemaMigrations();
  ensureSwLifecycle();
  connectNativeBridge();
});

async function runSchemaMigrations() {
  const stored = await chrome.storage.local.get(null);
  let state = stored;
  const versioned = Object.values(stored).find((entry) => entry && typeof entry === "object" && "_schema" in entry);
  if (versioned) state = versioned;
  const rollback = rollbackIfUnsupported(state, { stage: "fresh" });
  if (rollback.backup) {
    await chrome.storage.local.set({ orchordsExtensionBackup: rollback.backup });
  }
  const result = runMigrations(rollback.state);
  if (result.ok) {
    await chrome.storage.local.set({ orchordsExtensionRoot: result.state });
    logLifecycle(`schema migrated to v${result.state._schema}`);
  }
}

chrome.action.onClicked.addListener(() => {
  logLifecycle("one-time tab access granted by user gesture");
  ensureSwLifecycle();
  connectNativeBridge();
});

const USER_ACTIONS = new Set(Object.values(CONTROL_ACTIONS));
const SITE_AUTHZ_ACTIONS = new Set([
  "allow_once",
  "allow_for_site",
  "deny_site",
  "revoke_site",
]);
const DISPATCH_ACTIONS = new Set(["dispatch"]);

const ONBOARDING_ACTIONS = new Set([
  "advance_onboarding",
  "transition_onboarding",
  "reset_onboarding",
]);

function isPopupRequest(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return false;
  return message.kind === "user-action";
}

function isTrustedSender(sender) {
  return Boolean(sender && sender.id && sender.id === chrome.runtime.id);
}

chrome.runtime.onMessage.addListener((message, sender, _sendResponse) => {
  if (!isTrustedSender(sender)) {
    console.warn(`[${PRODUCT}] rejected extension message from untrusted sender`);
    return false;
  }
  if (message?.kind === "control-state:get") {
    void broadcastControlState();
    return false;
  }
  if (!isPopupRequest(message)) return false;
  const { action } = message;
  if (action === "snapshot") {
    void broadcastControlState();
    return false;
  }
  if (SITE_AUTHZ_ACTIONS.has(action)) {
    void (async () => {
      try {
        await siteAuthzReady;
        applySiteAuthorization(action, message.payload);
        await persistSiteAuthorizations();
      } catch (error) {
        console.warn(
          `[${PRODUCT}] rejected site-authorization ${action}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    })();
    return false;
  }
  if (action === "reset_pairing") {
    void (async () => {
      try {
        await chrome.storage.local.remove("orchordsNativeBridgePairing");
        pairingState = null;
        onboarding = resetOnboarding();
        await persistOnboarding();
        await broadcastControlState();
      } catch (error) {
        console.warn(
          `[${PRODUCT}] reset pairing failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    })();
    return false;
  }
  if (action === "set_settings") {
    void (async () => {
      try {
        await settingsReady;
        settings = await saveSettings(chrome.storage.local, message.payload ?? {});
        await broadcastControlState();
      } catch (error) {
        console.warn(
          `[${PRODUCT}] settings update failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    })();
    return false;
  }
  if (action === "run_doctor") {
    void broadcastControlState();
    return false;
  }
  if (action === "support_bundle") {
    void (async () => {
      try {
        const bundle = createSupportBundle(composeSnapshot());
        await chrome.storage.session.set({ orchordsSupportBundle: bundle });
        void broadcastControlState();
      } catch (error) {
        console.warn(
          `[${PRODUCT}] support bundle failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    })();
    return false;
  }
  if (ONBOARDING_ACTIONS.has(action)) {
    void (async () => {
      try {
        await onboardingReady;
        if (action === "advance_onboarding") {
          const r = advanceOnboarding(onboarding);
          if (r.changed) onboarding = r.state;
        } else if (action === "transition_onboarding") {
          const r = transitionOnboarding(onboarding, message.payload?.stage);
          if (r.changed) onboarding = r.state;
        } else if (action === "reset_onboarding") {
          onboarding = resetOnboarding();
        }
        await persistOnboarding();
      } catch (error) {
        console.warn(
          `[${PRODUCT}] onboarding ${action} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    })();
    return false;
  }
  if (!USER_ACTIONS.has(action)) {
    console.warn(`[${PRODUCT}] rejected unknown user action: ${String(action)}`);
    return false;
  }
  if (DISPATCH_ACTIONS.has(action)) {
    void (async () => {
      const token = typeof message.token === "string" ? message.token : "";
      const intent = typeof message.intent === "string" ? message.intent : "act";
      const runId = typeof message.runId === "string" ? message.runId : null;
      const verdict = await dispatchGate.enforce({ token, intent, runId });
      if (!verdict.allowed) {
        void broadcastControlState();
        console.warn(
          `[${PRODUCT}] dispatch refused: ${verdict.code} (${verdict.reason ?? "no reason"})`,
        );
        return;
      }
      // Authorised. The native bridge on the other side will receive the
      // already-tab-attached envelope — we never expose the tab URL or any
      // site-authorization state to the bridge directly.
      try {
        await broadcastControlState();
      } catch (error) {
        console.warn(
          `[${PRODUCT}] dispatch broadcast failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    })();
    return false;
  }
  void (async () => {
    try {
      await applyControlTransition({ type: action, actor: ACTOR.USER, reason: "user gesture" });
      if (
        action === CONTROL_ACTIONS.STOP ||
        action === CONTROL_ACTIONS.DISCONNECT
      ) {
        bridgeClient?.disconnect("user requested termination");
        bridgeClient = null;
        nativePort?.disconnect();
        nativePort = null;
        if (action === CONTROL_ACTIONS.STOP) {
          await chrome.storage.local.remove("orchordsNativeBridgePairing");
        }
      }
    } catch (error) {
      console.warn(
        `[${PRODUCT}] rejected user action ${action}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  })();
  return false;
});

connectNativeBridge();
ensureSwLifecycle();
void runSchemaMigrations();
