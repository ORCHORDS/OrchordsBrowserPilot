import { endianness } from "node:os";

export const NATIVE_HOST_NAME = "com.orchords.web_pilot";
export const DEFAULT_NATIVE_MESSAGE_LIMIT_BYTES = 1024 * 1024;

const EXTENSION_ORIGIN_RE = /^chrome-extension:\/\/[a-p]{32}\/$/;
const LITTLE_ENDIAN = endianness() === "LE";

function readFrameLength(header: Buffer): number {
  return LITTLE_ENDIAN ? header.readUInt32LE(0) : header.readUInt32BE(0);
}

function writeFrameLength(header: Buffer, length: number): void {
  if (LITTLE_ENDIAN) header.writeUInt32LE(length, 0);
  else header.writeUInt32BE(length, 0);
}

export function encodeNativeMessage(
  value: unknown,
  maxMessageBytes = DEFAULT_NATIVE_MESSAGE_LIMIT_BYTES,
): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.byteLength > maxMessageBytes) {
    throw new Error("native message exceeds native messaging limit");
  }
  const header = Buffer.allocUnsafe(4);
  writeFrameLength(header, body.byteLength);
  return Buffer.concat([header, body]);
}

export class NativeMessageDecoder {
  private buffer = Buffer.alloc(0);

  constructor(private readonly maxMessageBytes = DEFAULT_NATIVE_MESSAGE_LIMIT_BYTES) {}

  push(chunk: Uint8Array): unknown[] {
    if (chunk.byteLength === 0) return [];
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    const messages: unknown[] = [];

    while (this.buffer.byteLength >= 4) {
      const size = readFrameLength(this.buffer.subarray(0, 4));
      if (size > this.maxMessageBytes) {
        throw new Error("native message exceeds native messaging limit");
      }
      if (this.buffer.byteLength < 4 + size) break;

      const body = this.buffer.subarray(4, 4 + size);
      this.buffer = this.buffer.subarray(4 + size);
      try {
        messages.push(JSON.parse(body.toString("utf8")) as unknown);
      } catch {
        throw new Error("native message contains invalid JSON");
      }
    }

    return messages;
  }
}

function normalizeAllowedOrigins(allowedOrigins: readonly string[]): string[] {
  const unique = [...new Set(allowedOrigins)];
  if (unique.length === 0 || unique.some(origin => !EXTENSION_ORIGIN_RE.test(origin))) {
    throw new Error("allowed origins must be exact chrome-extension origins");
  }
  return unique;
}

export function validateNativeCallerOrigin(callerOrigin: string, allowedOrigins: readonly string[]): string {
  const normalized = normalizeAllowedOrigins(allowedOrigins);
  if (!normalized.includes(callerOrigin)) throw new Error("caller origin is not allowed");
  return callerOrigin;
}

export interface NativeHostManifestOptions {
  path: string;
  allowedOrigins: readonly string[];
}

export interface NativeHostManifest {
  name: typeof NATIVE_HOST_NAME;
  description: string;
  path: string;
  type: "stdio";
  allowed_origins: string[];
}

export function createNativeHostManifest(options: NativeHostManifestOptions): NativeHostManifest {
  if (!options.path) throw new Error("native host path is required");
  return {
    name: NATIVE_HOST_NAME,
    description: "Orchords Web Pilot native messaging host",
    path: options.path,
    type: "stdio",
    allowed_origins: normalizeAllowedOrigins(options.allowedOrigins),
  };
}
