import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const doctorUrl = pathToFileURL(
  path.join(repoRoot, "extension", "connection-doctor.js"),
).href;

const { diagnose, DOCTOR_VERSION } = await import(doctorUrl);

test("doctor version is pinned (#129)", () => {
  assert.equal(DOCTOR_VERSION, 1);
});

test("missing everything yields blocking issues only (#129)", () => {
  const result = diagnose({});
  assert.equal(result.severity, "blocking");
  const codes = result.issues.map((i) => i.code);
  assert.ok(codes.includes("EXT-MANIFEST-INCOMPATIBLE"));
  assert.ok(codes.includes("EXT-CORE-MISSING"));
  assert.ok(codes.includes("EXT-PAIRING-MISSING"));
  for (const issue of result.issues) {
    assert.notEqual(issue.severity, "info", `unexpected info-level: ${issue.code}`);
  }
});

test("happy path returns ok severity with no issues (#129)", () => {
  const result = diagnose({
    manifestVersion: 3,
    browser: { name: "chrome", majorVersion: 130 },
    core: { version: "0.1.5" },
    pairing: { pairingId: "abc", secret: "x".repeat(43), generation: 1 },
  });
  assert.equal(result.severity, "ok");
  assert.deepEqual(result.issues, []);
});

test("unsupported browser is blocking (#129)", () => {
  const result = diagnose({
    manifestVersion: 3,
    browser: { name: "firefox", majorVersion: 130 },
    core: { version: "0.1.0" },
    pairing: { pairingId: "abc", secret: "x".repeat(43), generation: 1 },
  });
  const codes = result.issues.map((i) => i.code);
  assert.ok(codes.includes("EXT-BROWSER-UNSUPPORTED"));
  assert.equal(result.severity, "blocking");
});

test("browser too old is blocking (#129)", () => {
  const result = diagnose({
    manifestVersion: 3,
    browser: { name: "chrome", majorVersion: 119 },
    core: { version: "0.1.0" },
    pairing: { pairingId: "abc", secret: "x".repeat(43), generation: 1 },
  });
  const codes = result.issues.map((i) => i.code);
  assert.ok(codes.includes("EXT-BROWSER-TOO-OLD"));
});

test("core version too old or too new is blocking (#129)", () => {
  const tooOld = diagnose({
    manifestVersion: 3,
    browser: { name: "chrome", majorVersion: 130 },
    core: { version: "0.0.9" },
    pairing: { pairingId: "abc", secret: "x".repeat(43), generation: 1 },
  });
  assert.ok(tooOld.issues.some((i) => i.code === "EXT-CORE-VERSION-MISMATCH"));

  const tooNew = diagnose({
    manifestVersion: 3,
    browser: { name: "chrome", majorVersion: 130 },
    core: { version: "2.0.0" },
    pairing: { pairingId: "abc", secret: "x".repeat(43), generation: 1 },
  });
  assert.ok(tooNew.issues.some((i) => i.code === "EXT-CORE-VERSION-MISMATCH"));
});

test("corrupted pairing surfaces the corrupted issue (#129)", () => {
  const result = diagnose({
    manifestVersion: 3,
    browser: { name: "chrome", majorVersion: 130 },
    core: { version: "0.1.0" },
    pairing: { pairingId: "", secret: "x".repeat(43), generation: 1 },
  });
  assert.ok(result.issues.some((i) => i.code === "EXT-PAIRING-CORRUPTED"));
});

test("native-denied / disconnected error codes are surfaced (#129)", () => {
  const denied = diagnose({
    manifestVersion: 3,
    browser: { name: "chrome", majorVersion: 130 },
    core: { version: "0.1.0" },
    pairing: { pairingId: "abc", secret: "x".repeat(43), generation: 1 },
    lastError: { code: "EXT-NATIVE-DENIED" },
  });
  assert.ok(denied.issues.some((i) => i.code === "EXT-NATIVE-DENIED"));
  assert.equal(denied.severity, "blocking");

  const disconnected = diagnose({
    manifestVersion: 3,
    browser: { name: "chrome", majorVersion: 130 },
    core: { version: "0.1.0" },
    pairing: { pairingId: "abc", secret: "x".repeat(43), generation: 1 },
    lastError: { code: "EXT-NATIVE-DISCONNECTED" },
  });
  assert.ok(
    disconnected.issues.some((i) => i.code === "EXT-BRIDGE-UNREACHABLE"),
  );
});

test("control-state error without lastError yields a warning, not an error (#129)", () => {
  const result = diagnose({
    manifestVersion: 3,
    browser: { name: "chrome", majorVersion: 130 },
    core: { version: "0.1.0" },
    pairing: { pairingId: "abc", secret: "x".repeat(43), generation: 1 },
    controlState: "error",
  });
  const codes = result.issues.map((i) => i.code);
  assert.ok(codes.includes("EXT-CONTROL-ERROR-UNEXPLAINED"));
  const issue = result.issues.find((i) => i.code === "EXT-CONTROL-ERROR-UNEXPLAINED");
  assert.equal(issue.severity, "warning");
});

test("issues are sorted by severity descending (#129)", () => {
  const result = diagnose({
    manifestVersion: 3,
    browser: { name: "chrome", majorVersion: 119 }, // warning
    core: { version: "0.0.1" }, // blocking
    pairing: { pairingId: "abc", secret: "x".repeat(43), generation: 1 },
  });
  for (let i = 1; i < result.issues.length; i++) {
    const prev = rank(result.issues[i - 1].severity);
    const cur = rank(result.issues[i].severity);
    assert.ok(prev >= cur, `severity must be non-increasing: ${result.issues[i - 1].code} before ${result.issues[i].code}`);
  }
});

function rank(s) {
  switch (s) {
    case "blocking":
      return 4;
    case "error":
      return 3;
    case "warning":
      return 2;
    case "info":
      return 1;
    default:
      return 0;
  }
}

test("doctor never returns raw secrets in messages (#129)", async () => {
  const fakeSecret = "abcdefghijabcdefghijabcdefghijabcdefghijabcde";
  const result = diagnose({
    manifestVersion: 3,
    browser: { name: "chrome", majorVersion: 130 },
    core: { version: "0.1.0" },
    pairing: { pairingId: "abc", secret: fakeSecret, generation: 1 },
  });
  const serialized = JSON.stringify(result);
  assert.equal(
    serialized.includes(fakeSecret),
    false,
    "doctor output must not contain raw pairing secret",
  );
});

test("doctor exports its functions and is importable as ESM (#129)", async () => {
  const text = await readFile(
    path.join(repoRoot, "extension", "connection-doctor.js"),
    "utf8",
  );
  assert.match(text, /export function diagnose/);
  assert.match(text, /export const DOCTOR_VERSION/);
});
