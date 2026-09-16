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
  // must not be written to stderr in clear text. Read it through a
  // getter that strips process.env-derived content so the tainted
  // string never reaches console.error.
  const safeName = err && typeof err === "object" && "name" in err
    ? String((err as { name: unknown }).name)
    : "Error";
  const safeMessage = err && typeof err === "object" && "message" in err
    ? String((err as { message: unknown }).message).replace(
        /\b[A-Z][A-Z0-9_]{2,}=[^\s,;]+/g,
        "[redacted-env-var]",
      )
    : "";
  console.error("orchords-web-pilot:", `${safeName}: ${safeMessage || "startup failed"}`);
  process.exit(1);
});
