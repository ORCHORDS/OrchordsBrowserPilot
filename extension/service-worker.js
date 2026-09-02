const PRODUCT = "Orchords Web Pilot";

function logLifecycle(event) {
  console.info(`[${PRODUCT}] extension ${event}`);
}

chrome.runtime.onInstalled.addListener(() => {
  logLifecycle("installed");
});

chrome.runtime.onStartup.addListener(() => {
  logLifecycle("started");
});

chrome.action.onClicked.addListener(() => {
  logLifecycle("one-time tab access granted by user gesture");
});
