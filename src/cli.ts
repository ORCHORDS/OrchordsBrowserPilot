#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { startHttp, startStdio } from "./server.js";

async function main() {
  const config = loadConfig();
  if (config.transport === "http") {
    await startHttp(config);
  } else {
    await startStdio(config);
  }
}

main().catch(err => {
  console.error("orchords-web-pilot:", err);
  process.exit(1);
});
