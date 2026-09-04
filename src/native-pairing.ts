import {
  createHash,
  createHmac,
  randomBytes as nodeRandomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

export interface PairingCredential {
  pairingId: string;
  secret: string;
  generation: number;
}

export interface PairingRecord {
  pairingId: string;
  callerOrigin: string;
  installId: string;
  profileId: string;
  secretHash: string;
  generation: number;
  status: "active" | "revoked";
  issuedAt: number;
  rotatedAt?: number;
  revokedAt?: number;
}

export interface PairingBinding {
  callerOrigin: string;
  installId: string;
  profileId: string;
}

interface CreatePairingOptions extends PairingBinding {
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
  randomUUID?: () => string;
}

interface RotateOptions {
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
}

export interface BridgeAuth {
  pairingId: string;
  generation: number;
  mac: string;
}

function secretVerifier(secret: string): Buffer {
  return createHash("sha256").update(Buffer.from(secret, "base64url")).digest();
}

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("bridge auth payload contains non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => compareKeys(a, b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  throw new Error(`unsupported bridge auth value type: ${typeof value}`);
}

function macFor(verifier: Buffer, envelope: unknown): Buffer {
  return createHmac("sha256", verifier).update(stableJson(envelope)).digest();
}

function safeHexEqual(expected: Buffer, actualHex: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(actualHex)) return false;
  const actual = Buffer.from(actualHex, "hex");
  return actual.length === expected.length && timingSafeEqual(expected, actual);
}

export function createPairing(options: CreatePairingOptions): { credential: PairingCredential; record: PairingRecord } {
  const now = options.now ?? Date.now;
  const randomBytes = options.randomBytes ?? nodeRandomBytes;
  const secret = randomBytes(32).toString("base64url");
  const pairingId = (options.randomUUID ?? randomUUID)();
  const secretHash = secretVerifier(secret).toString("hex");
  const issuedAt = now();
  return {
    credential: { pairingId, secret, generation: 1 },
    record: {
      pairingId,
      callerOrigin: options.callerOrigin,
      installId: options.installId,
      profileId: options.profileId,
      secretHash,
      generation: 1,
      status: "active",
      issuedAt,
    },
  };
}

export function rotatePairing(
  record: PairingRecord,
  options: RotateOptions = {},
): { credential: PairingCredential; record: PairingRecord } {
  if (record.status !== "active") throw new Error("cannot rotate revoked pairing");
  const now = options.now ?? Date.now;
  const randomBytes = options.randomBytes ?? nodeRandomBytes;
  const secret = randomBytes(32).toString("base64url");
  const generation = record.generation + 1;
  return {
    credential: { pairingId: record.pairingId, secret, generation },
    record: {
      ...record,
      secretHash: secretVerifier(secret).toString("hex"),
      generation,
      rotatedAt: now(),
    },
  };
}

export function revokePairing(record: PairingRecord, revokedAt = Date.now()): PairingRecord {
  return { ...record, status: "revoked", revokedAt };
}

export function signBridgeEnvelope(credential: PairingCredential, envelope: unknown): BridgeAuth {
  const verifier = secretVerifier(credential.secret);
  return {
    pairingId: credential.pairingId,
    generation: credential.generation,
    mac: macFor(verifier, envelope).toString("hex"),
  };
}

export function signBridgeEnvelopeWithRecord(record: PairingRecord, envelope: unknown): BridgeAuth {
  if (record.status !== "active" || !/^[a-f0-9]{64}$/i.test(record.secretHash)) {
    throw new Error("cannot sign with inactive pairing record");
  }
  return {
    pairingId: record.pairingId,
    generation: record.generation,
    mac: macFor(Buffer.from(record.secretHash, "hex"), envelope).toString("hex"),
  };
}

export function verifyBridgeEnvelopeAuth(
  record: PairingRecord,
  envelope: unknown,
  auth: BridgeAuth,
  binding: PairingBinding,
): boolean {
  if (record.status !== "active") return false;
  if (auth.pairingId !== record.pairingId || auth.generation !== record.generation) return false;
  if (
    binding.callerOrigin !== record.callerOrigin ||
    binding.installId !== record.installId ||
    binding.profileId !== record.profileId
  ) {
    return false;
  }
  if (!/^[a-f0-9]{64}$/i.test(record.secretHash)) return false;
  const verifier = Buffer.from(record.secretHash, "hex");
  return safeHexEqual(macFor(verifier, envelope), auth.mac);
}
