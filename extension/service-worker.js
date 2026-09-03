const PRODUCT = "Orchords Web Pilot";

let nativePort = null;

function logLifecycle(event) {
  console.info(`[${PRODUCT}] extension ${event}`);
}

function connectNativeBridge() {
  if (nativePort) return nativePort;

  const port = chrome.runtime.connectNative("com.orchords.web_pilot");
  nativePort = port;

  port.onMessage.addListener((message) => {
    if (message && typeof message === "object" && message.type === "bridge.ready") {
      logLifecycle("native bridge ready");
    }
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
