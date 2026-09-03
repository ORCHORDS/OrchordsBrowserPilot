#!/usr/bin/env node
import { parseNativeAllowedOrigins, runNativeHost } from "./native-host.js";

async function main(): Promise<void> {
  const callerOrigin = process.argv[2] ?? "";
  const allowedOrigins = parseNativeAllowedOrigins(process.env.ORCHORDS_NATIVE_ALLOWED_ORIGINS);
  await runNativeHost({
    callerOrigin,
    allowedOrigins,
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
