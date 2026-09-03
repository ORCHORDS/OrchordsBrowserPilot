import { randomBytes, randomUUID as nodeRandomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";

import {
  NativeMessageDecoder,
  encodeNativeMessage,
  validateNativeCallerOrigin,
} from "./native-messaging.js";

function defaultNonce(): string {
  return randomBytes(32).toString("hex");
}

export function parseNativeAllowedOrigins(value: string | undefined): string[] {
  const origins = [...new Set((value ?? "").split(",").map(v => v.trim()).filter(Boolean))];
  if (origins.length === 0) throw new Error("native messaging allowed origins are required");
  for (const origin of origins) validateNativeCallerOrigin(origin, [origin]);
  return origins;
}

export interface NativeHostRunOptions {
  callerOrigin: string;
  allowedOrigins: readonly string[];
  input: Readable;
  output: Writable;
  errors: Writable;
  now?: () => number;
  randomUUID?: () => string;
  randomNonce?: () => string;
}

function isBridgeHello(message: unknown): message is { protocol: 1; type: "bridge.hello" } {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return false;
  const candidate = message as Record<string, unknown>;
  return candidate.protocol === 1 && candidate.type === "bridge.hello";
}

export async function runNativeHost(options: NativeHostRunOptions): Promise<void> {
  const callerOrigin = validateNativeCallerOrigin(options.callerOrigin, options.allowedOrigins);
  const decoder = new NativeMessageDecoder();
  const now = options.now ?? Date.now;
  const randomUUID = options.randomUUID ?? nodeRandomUUID;
  const randomNonce = options.randomNonce ?? defaultNonce;

  for await (const chunk of options.input) {
    let messages: unknown[];
    try {
      messages = decoder.push(chunk as Uint8Array);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      options.errors.write(`native-host: ${detail}\n`);
      throw error;
    }

    for (const message of messages) {
      if (!isBridgeHello(message)) {
        const error = new Error("native host only accepts bridge.hello before authenticated dispatch");
        options.errors.write(`native-host: ${error.message}\n`);
        throw error;
      }

      options.output.write(
        encodeNativeMessage({
          protocol: 1,
          id: randomUUID(),
          nonce: randomNonce(),
          deadlineAt: now() + 30_000,
          type: "bridge.ready",
          payload: { callerOrigin },
        }),
      );
    }
  }
}
