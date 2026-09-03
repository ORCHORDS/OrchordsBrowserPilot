import {
  ReplayWindow,
  createBridgeEnvelope,
  validateBridgeEnvelope,
} from "./bridge-protocol.js";
import {
  acceptPairingResponse,
  createPairingHelloPayload,
  loadOrCreatePairingState,
} from "./pairing-state.js";

const PRODUCT = "Orchords Web Pilot";
const NATIVE_HOST = "com.orchords.web_pilot";
const REPLAY_STORAGE_KEY = "nativeBridgeReplayKeys";

let nativePort = null;
let replayWindow = new ReplayWindow();
let pairingState;

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

async function rememberBridgeEnvelope(message) {
  replayWindow.add(message);
  await chrome.storage.session.set({ [REPLAY_STORAGE_KEY]: replayWindow.toJSON() });
}

async function handleNativeMessage(message) {
  await replayReady;
  const result = validateBridgeEnvelope(message, { replay: replayWindow });
  if (!result.ok) {
    console.warn(`[${PRODUCT}] rejected native bridge envelope: ${result.code}`);
    return;
  }

  await rememberBridgeEnvelope(message);
  if (message.type === "bridge.paired" || message.type === "bridge.ready") {
    await pairingReady;
    pairingState = await acceptPairingResponse(chrome.storage.local, pairingState, message);
    logLifecycle(message.type === "bridge.paired" ? "native bridge paired" : "native bridge ready");
  }
}

function connectNativeBridge() {
  if (nativePort) return nativePort;

  const port = chrome.runtime.connectNative(NATIVE_HOST);
  nativePort = port;

  port.onMessage.addListener((message) => {
    void handleNativeMessage(message).catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`[${PRODUCT}] rejected native bridge response: ${detail}`);
    });
  });

  port.onDisconnect.addListener(() => {
    nativePort = null;
    const reason = chrome.runtime.lastError?.message;
    if (reason) {
      console.warn(`[${PRODUCT}] native bridge disconnected: ${reason}`);
    } else {
      console.warn(`[${PRODUCT}] native bridge disconnected`);
    }
  });

  void pairingReady
    .then((state) => {
      port.postMessage(createBridgeEnvelope("bridge.hello", createPairingHelloPayload(state)));
    })
    .catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
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

connectNativeBridge();
