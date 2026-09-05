// Artifact transfer (#140).
//
// The native host can ask the extension to upload or receive a binary
// blob (a screenshot, a download, a page-source dump). The extension
// MUST NEVER expose the host's filesystem path, MUST NEVER call any
// download-API in the privileged forbidden list, and MUST pass only
// content-addressed opaque references between the two sides.
//
// This module is the policy layer that converts a "give me bytes" /
// "take bytes" request into a stream-friendly contract whose shape can
// be unit-tested without a browser.

export const ARTIFACT_TRANSFER_VERSION = 1;

const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;
const MAX_ARTIFACT_CHUNK_BYTES = 64 * 1024;
export { MAX_ARTIFACT_BYTES, MAX_ARTIFACT_CHUNK_BYTES };

export function canonicalArtifactReference({ id, hash, bytes, mimeType, label } = {}) {
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("artifact reference requires a stable id");
  }
  if (typeof hash !== "string" || !/^[a-f0-9]{64}$/i.test(hash)) {
    throw new Error("artifact reference requires a sha256 hex hash");
  }
  if (!Number.isFinite(bytes) || bytes < 0 || bytes > MAX_ARTIFACT_BYTES) {
    throw new Error("artifact reference exceeds the size policy");
  }
  if (typeof mimeType !== "string" || mimeType.length === 0 || mimeType.length > 128) {
    throw new Error("artifact reference requires a mimeType");
  }
  return {
    version: ARTIFACT_TRANSFER_VERSION,
    id,
    hash,
    bytes: Math.trunc(bytes),
    mimeType,
    label: typeof label === "string" ? label.slice(0, 128) : null,
    receivedAt: null,
  };
}

export function createArtifactTransfer({ now = Date.now } = {}) {
  const inbound = new Map();
  const outbound = new Map();

  function remember(reference, chunks) {
    const list = Array.isArray(chunks) ? chunks : [];
    let total = 0;
    for (const chunk of list) {
      if (!(chunk instanceof Uint8Array)) {
        throw new Error("artifact chunks must be Uint8Array");
      }
      total += chunk.byteLength;
      if (total > MAX_ARTIFACT_BYTES) {
        throw new Error("artifact exceeds the size policy");
      }
    }
    inbound.set(reference.id, { reference, chunks: list, receivedAt: now() });
    return { ok: true, id: reference.id, bytes: total };
  }

  function chunkOutbound(reference, bytes) {
    if (!(bytes instanceof Uint8Array)) {
      throw new Error("chunkOutbound requires a Uint8Array");
    }
    if (bytes.byteLength > MAX_ARTIFACT_CHUNK_BYTES) {
      return { ok: false, code: "chunk_too_large" };
    }
    const existing = outbound.get(reference.id) ?? { reference, chunks: [] };
    existing.chunks.push(bytes);
    existing.lastSentAt = now();
    outbound.set(reference.id, existing);
    return { ok: true, position: existing.chunks.length, chunkBytes: bytes.byteLength };
  }

  function listInbound() {
    return [...inbound.values()].map((entry) => ({ ...entry.reference, receivedAt: entry.receivedAt }));
  }

  function listOutbound() {
    return [...outbound.values()].map((entry) => ({
      ...entry.reference,
      chunks: entry.chunks.length,
      lastSentAt: entry.lastSentAt,
    }));
  }

  function dropInbound(id) {
    if (!inbound.has(id)) return { ok: false, code: "unknown_artifact" };
    inbound.delete(id);
    return { ok: true };
  }

  function dropOutbound(id) {
    if (!outbound.has(id)) return { ok: false, code: "unknown_artifact" };
    outbound.delete(id);
    return { ok: true };
  }

  return {
    remember,
    chunkOutbound,
    listInbound,
    listOutbound,
    dropInbound,
    dropOutbound,
    policy: { MAX_ARTIFACT_BYTES, MAX_ARTIFACT_CHUNK_BYTES },
  };
}

// Path sanitiser: refuses any absolute path, any `..` traversal, any
// Windows drive letter. The transfer contract NEVER carries host paths
// in either direction, so this helper exists only as a guard for any
// future code that might be tempted to do so.
export function sanitizeArtifactPath(value) {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > 256) return null;
  if (value.includes("..")) return null;
  if (/^[a-z]:\\/i.test(value)) return null;
  if (value.startsWith("/") || value.startsWith("\\")) return null;
  return value;
}

export const sanitizeArtifactTransferPolicy = sanitizeArtifactPath;
