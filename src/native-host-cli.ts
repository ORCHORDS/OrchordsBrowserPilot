#!/usr/bin/env node
import { createHash } from "node:crypto";
import { homedir, userInfo } from "node:os";
import path from "node:path";

import { parseNativeAllowedOrigins, runNativeHost } from "./native-host.js";

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
  await runNativeHost({
    callerOrigin,
    allowedOrigins,
    profileId: process.env.ORCHORDS_NATIVE_PROFILE_ID ?? defaultProfileId(),
    pairingFile: process.env.ORCHORDS_NATIVE_PAIRING_FILE ?? defaultPairingFile(),
    input: process.stdin,
    output: process.stdout,
    errors: process.stderr,
  });
}

main().catch(error => {
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(`orchords-web-pilot-native-host: ${detail}\n`);
  process.exitCode = 1;
});
