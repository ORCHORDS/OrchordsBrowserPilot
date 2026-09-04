import { randomBytes, randomUUID as nodeRandomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";

import { validateAuthenticatedBridgeMessage, type AuthenticatedBridgeValidation } from "./native-bridge-auth.js";
import {
  NativeMessageDecoder,
  encodeNativeMessage,
  validateNativeCallerOrigin,
} from "./native-messaging.js";
import { PairingRegistry } from "./native-pairing-registry.js";
import { loadPairingState, savePairingState } from "./native-pairing-store.js";
import { signBridgeEnvelopeWithRecord, type PairingRecord } from "./native-pairing.js";
import {
  appendNativeReplayKey,
  loadNativeReplayState,
  saveNativeReplayState,
  type NativeReplayState,
} from "./native-replay-store.js";

function defaultNonce(): string {
  return randomBytes(32).toString("hex");
}

export function parseNativeAllowedOrigins(value: string | undefined): string[] {
  const origins = [...new Set((value ?? "").split(",").map(v => v.trim()).filter(Boolean))];
  if (origins.length === 0) throw new Error("native messaging allowed origins are required");
  for (const origin of origins) validateNativeCallerOrigin(origin, [origin]);
  return origins;
}

export interface NativeToolCaller {
  callTool(
    name: string,
    args: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
}

export interface NativeHostRunOptions {
  callerOrigin: string;
  allowedOrigins: readonly string[];
  profileId: string;
  pairingFile: string;
  replayFile: string;
  toolCaller?: NativeToolCaller;
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

function parseBridgeHello(message: unknown): BridgeHello | null {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return null;
  const candidate = message as Record<string, unknown>;
  if (candidate.protocol !== 1 || candidate.type !== "bridge.hello") return null;
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

function parseToolPayload(payload: unknown): { tool: string; arguments: Record<string, unknown> } {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new Error("bridge request payload is malformed");
  const value = payload as Record<string, unknown>;
  if (typeof value.tool !== "string" || !value.tool) throw new Error("bridge request tool is required");
  const args = value.arguments;
  if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
    throw new Error("bridge request arguments are malformed");
  }
  return { tool: value.tool, arguments: (args ?? {}) as Record<string, unknown> };
}

function parseCancelPayload(payload: unknown): string {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new Error("bridge cancel payload is malformed");
  const requestId = (payload as Record<string, unknown>).requestId;
  if (typeof requestId !== "string" || !requestId) throw new Error("bridge cancel requestId is required");
  return requestId;
}

export async function runNativeHost(options: NativeHostRunOptions): Promise<void> {
  const callerOrigin = validateNativeCallerOrigin(options.callerOrigin, options.allowedOrigins);
  if (!options.profileId) throw new Error("native host profile id is required");
  if (!options.pairingFile) throw new Error("native host pairing file is required");
  if (!options.replayFile) throw new Error("native host replay file is required");

  const registry = new PairingRegistry(await loadPairingState(options.pairingFile), {
    now: options.now,
    randomUUID: options.randomPairingUUID,
    randomBytes: options.randomPairingBytes,
  });
  let replayState: NativeReplayState = await loadNativeReplayState(options.replayFile);
  let replayMutation: Promise<void> = Promise.resolve();
  let activePairing: PairingRecord | undefined;
  const activeRequests = new Map<string, AbortController>();
  const pending = new Set<Promise<void>>();
  const decoder = new NativeMessageDecoder();
  const now = options.now ?? Date.now;
  const randomUUID = options.randomUUID ?? nodeRandomUUID;
  const randomNonce = options.randomNonce ?? defaultNonce;

  const writeSigned = (type: string, payload: unknown, record: PairingRecord): void => {
    const envelope = {
      protocol: 1 as const,
      id: randomUUID(),
      nonce: randomNonce(),
      deadlineAt: now() + 30_000,
      type,
      payload,
    };
    options.output.write(encodeNativeMessage({ ...envelope, auth: signBridgeEnvelopeWithRecord(record, envelope) }));
  };

  const reserveAuthenticated = async (message: unknown): Promise<AuthenticatedBridgeValidation> => {
    if (!activePairing) throw new Error("bridge request arrived before pairing handshake");
    let validation: AuthenticatedBridgeValidation | undefined;
    let mutationError: unknown;
    replayMutation = replayMutation.then(async () => {
      try {
        validation = validateAuthenticatedBridgeMessage(message, {
          record: activePairing!,
          binding: {
            callerOrigin,
            installId: activePairing!.installId,
            profileId: options.profileId,
          },
          replayKeys: new Set(replayState.keys),
          now,
        });
        const next = appendNativeReplayKey(replayState, validation.replayKey);
        await saveNativeReplayState(options.replayFile, next);
        replayState = next;
      } catch (error) {
        mutationError = error;
      }
    });
    await replayMutation;
    if (mutationError) throw mutationError;
    if (!validation) throw new Error("bridge replay reservation failed");
    return validation;
  };

  const handleRequest = async (validation: AuthenticatedBridgeValidation): Promise<void> => {
    const record = activePairing;
    if (!record) throw new Error("bridge pairing lost");
    if (!options.toolCaller) throw new Error("authenticated native bridge dispatch is unavailable");
    const request = parseToolPayload(validation.envelope.payload);
    const controller = new AbortController();
    activeRequests.set(validation.envelope.id, controller);
    try {
      const result = await options.toolCaller.callTool(request.tool, request.arguments, { signal: controller.signal });
      writeSigned("bridge.response", { requestId: validation.envelope.id, result }, record);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      writeSigned("bridge.response", { requestId: validation.envelope.id, error: detail }, record);
    } finally {
      activeRequests.delete(validation.envelope.id);
    }
  };

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
      try {
        const hello = parseBridgeHello(rawMessage);
        if (hello) {
          if (activePairing) throw new Error("bridge.hello already completed for this connection");
          const result = registry.hello({
            callerOrigin,
            installId: hello.payload.installId,
            profileId: options.profileId,
            pairingId: hello.payload.pairingId,
          });
          if (result.kind === "paired") await savePairingState(options.pairingFile, registry.snapshot());
          activePairing = result.record;
          const type = result.kind === "paired" ? "bridge.paired" : "bridge.ready";
          const payload: Record<string, unknown> = {
            callerOrigin,
            installId: result.record.installId,
            pairingId: result.record.pairingId,
            generation: result.record.generation,
          };
          if (result.credential) payload.secret = result.credential.secret;
          writeSigned(type, payload, result.record);
          continue;
        }

        const validation = await reserveAuthenticated(rawMessage);
        if (validation.envelope.type === "bridge.cancel") {
          const requestId = parseCancelPayload(validation.envelope.payload);
          const controller = activeRequests.get(requestId);
          if (controller && !controller.signal.aborted) controller.abort(new Error("cancelled by extension"));
          writeSigned("bridge.cancelled", { requestId, cancelled: Boolean(controller) }, activePairing!);
          continue;
        }

        let task: Promise<void>;
        task = handleRequest(validation)
          .catch((error) => {
            const detail = error instanceof Error ? error.message : String(error);
            options.errors.write(`native-host: ${detail}\n`);
          })
          .finally(() => pending.delete(task));
        pending.add(task);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        options.errors.write(`native-host: ${detail}\n`);
        throw error;
      }
    }
  }

  await Promise.allSettled([...pending]);
}
