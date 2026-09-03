import { randomBytes, randomUUID as nodeRandomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";

import {
  NativeMessageDecoder,
  encodeNativeMessage,
  validateNativeCallerOrigin,
} from "./native-messaging.js";
import { PairingRegistry } from "./native-pairing-registry.js";
import { loadPairingState, savePairingState } from "./native-pairing-store.js";

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
  profileId: string;
  pairingFile: string;
  input: Readable;
  output: Writable;
  errors: Writable;
  now?: () => number;
  randomUUID?: () => string;
  randomNonce?: () => string;
  randomPairingUUID?: () => string;
  randomPairingBytes?: (size: number) => Buffer;
}

interface BridgeHello {
  protocol: 1;
  type: "bridge.hello";
  payload: {
    installId: string;
    pairingId?: string;
  };
}

function parseBridgeHello(message: unknown): BridgeHello {
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    throw new Error("native host only accepts bridge.hello before authenticated dispatch");
  }
  const candidate = message as Record<string, unknown>;
  if (candidate.protocol !== 1 || candidate.type !== "bridge.hello") {
    throw new Error("native host only accepts bridge.hello before authenticated dispatch");
  }
  if (typeof candidate.payload !== "object" || candidate.payload === null || Array.isArray(candidate.payload)) {
    throw new Error("bridge.hello payload is required");
  }
  const payload = candidate.payload as Record<string, unknown>;
  if (typeof payload.installId !== "string" || payload.installId.length < 16 || payload.installId.length > 256) {
    throw new Error("bridge.hello installId is invalid");
  }
  if (payload.pairingId !== undefined && (typeof payload.pairingId !== "string" || payload.pairingId.length === 0)) {
    throw new Error("bridge.hello pairingId is invalid");
  }
  return {
    protocol: 1,
    type: "bridge.hello",
    payload: { installId: payload.installId, pairingId: payload.pairingId as string | undefined },
  };
}

export async function runNativeHost(options: NativeHostRunOptions): Promise<void> {
  const callerOrigin = validateNativeCallerOrigin(options.callerOrigin, options.allowedOrigins);
  if (!options.profileId) throw new Error("native host profile id is required");
  if (!options.pairingFile) throw new Error("native host pairing file is required");

  const registry = new PairingRegistry(await loadPairingState(options.pairingFile), {
    now: options.now,
    randomUUID: options.randomPairingUUID,
    randomBytes: options.randomPairingBytes,
  });
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

    for (const rawMessage of messages) {
      let hello: BridgeHello;
      try {
        hello = parseBridgeHello(rawMessage);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        options.errors.write(`native-host: ${detail}\n`);
        throw error;
      }

      const result = registry.hello({
        callerOrigin,
        installId: hello.payload.installId,
        profileId: options.profileId,
        pairingId: hello.payload.pairingId,
      });

      if (result.kind === "paired") {
        await savePairingState(options.pairingFile, registry.snapshot());
      }

      const type = result.kind === "paired" ? "bridge.paired" : "bridge.ready";
      const payload: Record<string, unknown> = {
        callerOrigin,
        installId: result.record.installId,
        pairingId: result.record.pairingId,
        generation: result.record.generation,
      };
      if (result.credential) payload.secret = result.credential.secret;

      options.output.write(
        encodeNativeMessage({
          protocol: 1,
          id: randomUUID(),
          nonce: randomNonce(),
          deadlineAt: now() + 30_000,
          type,
          payload,
        }),
      );
    }
  }
}
