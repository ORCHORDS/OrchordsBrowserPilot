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
