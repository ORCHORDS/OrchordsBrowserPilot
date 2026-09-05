import assert from "node:assert/strict";
import test from "node:test";

import {
  BRIDGE_PROTOCOL_VERSION,
  EXTENSION_MAX_CORE_VERSION,
  EXTENSION_MIN_CORE_VERSION,
  createBridgeCompatReport,
  createBridgeHelloPayload,
  createBridgeWelcomePayload,
  evaluateCompatibility,
} from "../extension/bridge-protocol.js";

test("bridge.hello payload freezes protocol + version range (#123)", () => {
  const hello = createBridgeHelloPayload({ extensionVersion: "0.1.0" });
  assert.equal(hello.kind, "bridge.hello");
  assert.equal(hello.bridgeProtocol, BRIDGE_PROTOCOL_VERSION);
  assert.equal(hello.extensionVersion, "0.1.0");
  assert.equal(hello.minCoreVersion, EXTENSION_MIN_CORE_VERSION);
  assert.equal(hello.maxCoreVersion, EXTENSION_MAX_CORE_VERSION);
});

test("bridge.welcome payload freezes protocol + core version (#123)", () => {
  const welcome = createBridgeWelcomePayload({ coreVersion: "0.1.2" });
  assert.equal(welcome.kind, "bridge.welcome");
  assert.equal(welcome.bridgeProtocol, BRIDGE_PROTOCOL_VERSION);
  assert.equal(welcome.coreVersion, "0.1.2");
});

test("evaluateCompatibility accepts a matching hello/welcome pair (#123)", () => {
  const hello = createBridgeHelloPayload({ extensionVersion: "0.1.0" });
  const welcome = createBridgeWelcomePayload({ coreVersion: "0.1.3" });
  const result = evaluateCompatibility({ hello, welcome });
  assert.deepEqual(result, { ok: true, coreVersion: "0.1.3", extensionVersion: "0.1.0" });
});

test("evaluateCompatibility rejects a core version below the floor (#123)", () => {
  const hello = createBridgeHelloPayload({ extensionVersion: "0.1.0" });
  const welcome = createBridgeWelcomePayload({ coreVersion: "0.0.99" });
  const result = evaluateCompatibility({ hello, welcome });
  assert.equal(result.ok, false);
  assert.equal(result.code, "core_version_out_of_range");
  assert.equal(result.coreVersion, "0.0.99");
});

test("evaluateCompatibility rejects a mismatched bridge protocol (#123)", () => {
  const hello = createBridgeHelloPayload({ extensionVersion: "0.1.0" });
  hello.bridgeProtocol = 999;
  const welcome = createBridgeWelcomePayload({ coreVersion: "0.1.0" });
  const result = evaluateCompatibility({ hello, welcome });
  assert.equal(result.ok, false);
  assert.equal(result.code, "protocol_hello");
});

test("evaluateCompatibility rejects a malformed welcome payload (#123)", () => {
  const hello = createBridgeHelloPayload({ extensionVersion: "0.1.0" });
  const result = evaluateCompatibility({ hello, welcome: null });
  assert.equal(result.ok, false);
  assert.equal(result.code, "malformed_welcome");
});

test("evaluateCompatibility rejects an out-of-range extension version (#123)", () => {
  const hello = createBridgeHelloPayload({ extensionVersion: "0.2.0" });
  const welcome = createBridgeWelcomePayload({ coreVersion: "0.1.0" });
  const result = evaluateCompatibility({ hello, welcome });
  assert.equal(result.ok, false);
  assert.equal(result.code, "extension_version_out_of_range");
});

test("compat.report envelope payload is well-formed (#123)", () => {
  const report = createBridgeCompatReport({
    coreVersion: "0.1.0",
    extensionVersion: "0.1.0",
  });
  assert.equal(report.kind, "bridge.compat.report");
  assert.equal(report.bridgeProtocol, BRIDGE_PROTOCOL_VERSION);
  assert.equal(report.coreVersion, "0.1.0");
  assert.equal(report.extensionVersion, "0.1.0");
});
