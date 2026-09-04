#!/usr/bin/env node
import { createHash } from "node:crypto";
import { homedir, userInfo } from "node:os";
import path from "node:path";

import { createBrowserManager } from "./browser.js";
import { CanonicalMcpBridge } from "./canonical-mcp-bridge.js";
import { loadConfig } from "./config.js";
import { parseNativeAllowedOrigins, runNativeHost } from "./native-host.js";
import { Session } from "./session.js";

function defaultPairingFile(): string {
  return path.join(homedir(), ".orchords", "web-pilot", "native-pairings.json");
}

function defaultProfileId(): string {
  const user = userInfo();
  return createHash("sha256")
    .update(`${user.username}\0${homedir()}`)
    .digest("hex");
}

async function main(): Promise<void> {
  const callerOrigin = process.argv[2] ?? "";
  const allowedOrigins = parseNativeAllowedOrigins(process.env.ORCHORDS_NATIVE_ALLOWED_ORIGINS);
  const profileId = process.env.ORCHORDS_NATIVE_PROFILE_ID ?? defaultProfileId();
  const pairingFile = process.env.ORCHORDS_NATIVE_PAIRING_FILE ?? defaultPairingFile();
  const replayFile = process.env.ORCHORDS_NATIVE_REPLAY_FILE ?? `${pairingFile}.replay`;
  const config = loadConfig();
  const manager = createBrowserManager(config.browser.wsEndpoint, config.browser.headless);
  const session = new Session(`native:${profileId}`, manager, {
    maxConcurrent: config.operations.maxConcurrent,
    queueMax: config.operations.queueMax,
  });
  const bridge = await CanonicalMcpBridge.create(
    session,
    { url: config.captcha.url, token: config.captcha.token },
    { policyMode: config.policy.mode },
  );

  try {
    await runNativeHost({
      callerOrigin,
      allowedOrigins,
      profileId,
      pairingFile,
      replayFile,
      toolCaller: bridge,
      input: process.stdin,
      output: process.stdout,
      errors: process.stderr,
    });
  } finally {
    await bridge.close().catch(() => undefined);
    await session.dispose().catch(() => undefined);
    await manager.close().catch(() => undefined);
  }
}

main().catch(error => {
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(`orchords-web-pilot-native-host: ${detail}\n`);
  process.exitCode = 1;
});
