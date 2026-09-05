import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_ARTIFACT_BYTES,
  canonicalArtifactReference,
  createArtifactTransfer,
  sanitizeArtifactPath,
} from "../extension/artifact-transfer.js";

function goodRef(overrides = {}) {
  return canonicalArtifactReference({
    id: "art-1",
    hash: "a".repeat(64),
    bytes: 1024,
    mimeType: "image/png",
    label: "screenshot",
    ...overrides,
  });
}

test("canonicalArtifactReference requires a sha256 hash (#140)", () => {
  assert.throws(() => canonicalArtifactReference({ id: "x", hash: "short", bytes: 1, mimeType: "image/png" }), /sha256/);
});

test("canonicalArtifactReference enforces the size policy (#140)", () => {
  assert.throws(() => canonicalArtifactReference({
    id: "x", hash: "a".repeat(64), bytes: MAX_ARTIFACT_BYTES + 1, mimeType: "image/png",
  }), /size policy/);
});

test("canonicalArtifactReference requires a mimeType (#140)", () => {
  assert.throws(() => canonicalArtifactReference({
    id: "x", hash: "a".repeat(64), bytes: 1024, mimeType: "",
  }), /mimeType/);
});

test("ArtifactTransfer.remember collects inbound chunks and caps the size (#140)", () => {
  const t = createArtifactTransfer();
  const ref = goodRef();
  const chunks = [new Uint8Array(8), new Uint8Array(16)];
  const result = t.remember(ref, chunks);
  assert.equal(result.ok, true);
  assert.equal(result.bytes, 24);
  assert.equal(t.listInbound().length, 1);
});

test("ArtifactTransfer.chunkOutbound rejects over-large chunks (#140)", () => {
  const t = createArtifactTransfer();
  const result = t.chunkOutbound(goodRef(), new Uint8Array(128 * 1024));
  assert.equal(result.ok, false);
  assert.equal(result.code, "chunk_too_large");
});

test("ArtifactTransfer listOutbound / listInbound only carry references, never paths (#140)", () => {
  const t = createArtifactTransfer();
  t.remember(goodRef(), [new Uint8Array(1)]);
  t.chunkOutbound(goodRef(), new Uint8Array(1));
  const inbound = t.listInbound();
  const outbound = t.listOutbound();
  for (const r of [...inbound, ...outbound]) {
    assert.equal("path" in r, false);
    assert.equal("localPath" in r, false);
    assert.equal("hostPath" in r, false);
  }
});

test("ArtifactTransfer.dropInbound / dropOutbound (#140)", () => {
  const t = createArtifactTransfer();
  const ref = goodRef({ id: "art-x" });
  t.remember(ref, [new Uint8Array(1)]);
  assert.deepEqual(t.dropInbound("art-x"), { ok: true });
  assert.deepEqual(t.dropInbound("art-x"), { ok: false, code: "unknown_artifact" });
  t.chunkOutbound(ref, new Uint8Array(1));
  assert.deepEqual(t.dropOutbound("art-x"), { ok: true });
});

test("sanitizeArtifactPath refuses absolute / traversal / drive-letter paths (#140)", () => {
  assert.equal(sanitizeArtifactPath("rel/path.txt"), "rel/path.txt");
  assert.equal(sanitizeArtifactPath(""), null);
  assert.equal(sanitizeArtifactPath("../etc/passwd"), null);
  assert.equal(sanitizeArtifactPath("C:\\Windows\\System32"), null);
  assert.equal(sanitizeArtifactPath("/etc/passwd"), null);
  assert.equal(sanitizeArtifactPath("\\\\server\\share"), null);
  assert.equal(sanitizeArtifactPath(null), null);
});
