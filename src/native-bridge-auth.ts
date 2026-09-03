import type { PairingBinding, PairingRecord, BridgeAuth } from "./native-pairing.js";
import { verifyBridgeEnvelopeAuth } from "./native-pairing.js";

export const MAX_AUTHENTICATED_BRIDGE_BYTES = 1024 * 1024;
export const MAX_AUTHENTICATED_BRIDGE_TTL_MS = 5 * 60_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface UnsignedBridgeEnvelope {
  protocol: 1;
  id: string;
  nonce: string;
  deadlineAt: number;
  type: "bridge.request" | "bridge.cancel";
  payload: unknown;
}

export interface AuthenticatedBridgeValidation {
  envelope: UnsignedBridgeEnvelope;
  auth: BridgeAuth;
  replayKey: string;
}

function encodedBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function parseAuth(value: unknown): BridgeAuth {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("bridge auth is missing");
  const auth = value as Record<string, unknown>;
  if (
    typeof auth.pairingId !== "string" ||
    !Number.isInteger(auth.generation) ||
    typeof auth.mac !== "string" ||
    !/^[a-f0-9]{64}$/i.test(auth.mac)
  ) {
    throw new Error("bridge auth is malformed");
  }
  return { pairingId: auth.pairingId, generation: auth.generation as number, mac: auth.mac };
}

export function validateAuthenticatedBridgeMessage(
  message: unknown,
  options: {
    record: PairingRecord;
    binding: PairingBinding;
    replayKeys: ReadonlySet<string>;
    now?: () => number;
  },
): AuthenticatedBridgeValidation {
  const now = options.now ?? Date.now;
  if (typeof message !== "object" || message === null || Array.isArray(message)) throw new Error("bridge message is malformed");
  if (encodedBytes(message) > MAX_AUTHENTICATED_BRIDGE_BYTES) throw new Error("bridge message is too large");

  const candidate = message as Record<string, unknown>;
  if (candidate.protocol !== 1) throw new Error("bridge protocol version is unsupported");
  if (candidate.type !== "bridge.request" && candidate.type !== "bridge.cancel") throw new Error("bridge message type is unsupported");
  if (typeof candidate.id !== "string" || !UUID_RE.test(candidate.id)) throw new Error("bridge request id is malformed");
  if (typeof candidate.nonce !== "string" || candidate.nonce.length < 32 || candidate.nonce.length > 256) {
    throw new Error("bridge nonce is malformed");
  }
  if (typeof candidate.deadlineAt !== "number" || !Number.isFinite(candidate.deadlineAt)) {
    throw new Error("bridge deadline is malformed");
  }
  const current = now();
  if (candidate.deadlineAt < current) throw new Error("bridge message expired");
  if (candidate.deadlineAt > current + MAX_AUTHENTICATED_BRIDGE_TTL_MS) throw new Error("bridge deadline is too far in the future");

  const envelope: UnsignedBridgeEnvelope = {
    protocol: 1,
    id: candidate.id,
    nonce: candidate.nonce,
    deadlineAt: candidate.deadlineAt,
    type: candidate.type,
    payload: candidate.payload,
  };
  const auth = parseAuth(candidate.auth);
  const replayKey = `${envelope.id}:${envelope.nonce}`;
  if (options.replayKeys.has(replayKey)) throw new Error("bridge message replay detected");
  if (!verifyBridgeEnvelopeAuth(options.record, envelope, auth, options.binding)) {
    throw new Error("bridge authentication failed");
  }
  return { envelope, auth, replayKey };
}
