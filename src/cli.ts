#!/usr/bin/env node
import { assertInstalledPlaywrightSupported } from "./compat.js";
import { loadConfig } from "./config.js";
import { startHttp, startStdio } from "./server.js";

async function main() {
  assertInstalledPlaywrightSupported();
  const config = loadConfig();
  if (config.transport === "http") {
    await startHttp(config);
  } else {
    await startStdio(config);
  }
}

main().catch(err => {
  // Surface only the error name; the message may carry environment
  // values (e.g. PILOT_CAPTCHA_SOLVER_TOKEN) read by loadConfig that
  // must not be written to stderr in clear text.
  const name = err instanceof Error ? err.name : "Error";
  console.error("orchords-web-pilot:", `${name}: startup failed`);
  process.exit(1);
});
