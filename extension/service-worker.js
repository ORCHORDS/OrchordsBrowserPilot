import {
  ReplayWindow,
  createBridgeEnvelope,
  validateBridgeEnvelope,
} from "./bridge-protocol.js";
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

const PRODUCT = "Orchords Web Pilot";
const NATIVE_HOST = "com.orchords.web_pilot";
const REPLAY_STORAGE_KEY = "nativeBridgeReplayKeys";
const CONTROL_STATE_STORAGE_KEY = "nativeBridgeControlState";

let nativePort = null;
let bridgeClient = null;
let replayWindow = new ReplayWindow();
let pairingState;
let controlState = createControlState({ initial: CONTROL_STATES.DISCONNECTED });

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

async function persistControlState() {
  const snap = controlState.snapshot();
  await chrome.storage.session.set({ [CONTROL_STATE_STORAGE_KEY]: snap });
  await broadcastControlState();
  await renderBadge();
}

async function broadcastControlState() {
  try {
    await chrome.runtime.sendMessage({
      kind: "control-state:update",
      snapshot: controlState.snapshot(),
    });
  } catch {
    // Popup may not be open; sendMessage rejects when no listener.
  }
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

async function handleNativeMessage(message) {
  await replayReady;
  const result = validateBridgeEnvelope(message, { replay: replayWindow });
  if (!result.ok) {
    console.warn(`[${PRODUCT}] rejected native bridge envelope: ${result.code}`);
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
    void applyControlTransition({
      type: "bridge.disconnected",
      actor: ACTOR.SYSTEM,
      reason: reason ?? "native bridge disconnected",
    });
    if (reason) {
      console.warn(`[${PRODUCT}] native bridge disconnected: ${reason}`);
    } else {
      console.warn(`[${PRODUCT}] native bridge disconnected`);
    }
  });

  void Promise.all([pairingReady, controlStateReady])
    .then(() => {
      port.postMessage(createBridgeEnvelope("bridge.hello", createPairingHelloPayload(pairingState)));
    })
    .catch((error) => {
      const detail = error instanceof Error ? String(error.message) : String(error);
      console.warn(`[${PRODUCT}] native bridge pairing state unavailable: ${detail}`);
      port.disconnect();
    });

  return port;
}

chrome.runtime.onInstalled.addListener(() => {
  logLifecycle("installed");
  connectNativeBridge();
});

chrome.runtime.onStartup.addListener(() => {
  logLifecycle("started");
  connectNativeBridge();
});

chrome.action.onClicked.addListener(() => {
  logLifecycle("one-time tab access granted by user gesture");
  connectNativeBridge();
});

const USER_ACTIONS = new Set(Object.values(CONTROL_ACTIONS));

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
  if (!USER_ACTIONS.has(action)) {
    console.warn(`[${PRODUCT}] rejected unknown user action: ${String(action)}`);
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
