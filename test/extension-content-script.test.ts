import assert from "node:assert/strict";
import test from "node:test";

import {
  RELAY_KIND,
  RELAY_PROTOCOL_VERSION,
  createBridgeRelay,
} from "../extension/bridge-relay.js";

function makeRuntime() {
  const listeners = new Set();
  const sentToBackground = [];
  let disconnected = false;
  let onDisconnectHandler = null;
  let onMessageHandler = null;
  return {
    listeners,
    sentToBackground,
    connect() {
      const port = {
        postMessage: (msg) => sentToBackground.push(msg),
        disconnect: () => {
          disconnected = true;
          onDisconnectHandler?.();
        },
        onMessage: {
          addListener(fn) {
            onMessageHandler = fn;
          },
        },
        onDisconnect: {
          addListener(fn) {
            onDisconnectHandler = fn;
          },
        },
        _isOpen() {
          return !disconnected;
        },
      };
      return port;
    },
    deliver(message) {
      onMessageHandler?.(message);
    },
    triggerDisconnect() {
      onDisconnectHandler?.();
    },
  };
}

test("BridgeRelay hello envelope is well-formed (#127)", () => {
  const runtime = makeRuntime();
  const relay = createBridgeRelay({ runtime, now: () => 1_000, randomId: () => "fixed-id" });
  const hello = relay.hello();
  assert.equal(hello.kind, RELAY_KIND.RELAY_HELLO);
  assert.equal(hello.protocol, RELAY_PROTOCOL_VERSION);
  assert.equal(hello.issuedAt, 1_000);
});

test("BridgeRelay publishes events over the connected port (#127)", () => {
  const runtime = makeRuntime();
  const relay = createBridgeRelay({ runtime, now: () => 1_000, randomId: () => "fixed-id" });
  relay.publish({ kind: "scroll", y: 100 });
  assert.equal(runtime.sentToBackground.length, 1);
  const msg = runtime.sentToBackground[0];
  assert.equal(msg.kind, RELAY_KIND.PAGE_EVENT);
  assert.equal(msg.protocol, RELAY_PROTOCOL_VERSION);
  assert.deepEqual(msg.payload, { kind: "scroll", y: 100 });
});

test("BridgeRelay.sendToPage resolves with the matched response (#127)", async () => {
  const runtime = makeRuntime();
  const relay = createBridgeRelay({ runtime, now: () => 1_000, randomId: () => "abc" });
  const pending = relay.sendToPage({ op: "meta" });
  await new Promise((r) => setImmediate(r));
  assert.equal(runtime.sentToBackground.length, 1);
  runtime.deliver({ kind: RELAY_KIND.PAGE_RESPONSE, id: "abc", payload: { title: "hi" } });
  const result = await pending;
  assert.deepEqual(result, { title: "hi" });
});

test("BridgeRelay.sendToPage rejects on error response (#127)", async () => {
  const runtime = makeRuntime();
  const relay = createBridgeRelay({ runtime, randomId: () => "xyz" });
  const pending = relay.sendToPage({ op: "meta" });
  await new Promise((r) => setImmediate(r));
  runtime.deliver({ kind: RELAY_KIND.PAGE_RESPONSE, id: "xyz", error: "denied" });
  await assert.rejects(() => pending, /denied/);
});

test("BridgeRelay.sendToPage rejects on disconnect (#127)", async () => {
  const runtime = makeRuntime();
  const relay = createBridgeRelay({ runtime, randomId: () => "qq" });
  const pending = relay.sendToPage({ op: "meta" });
  await new Promise((r) => setImmediate(r));
  runtime.triggerDisconnect();
  await assert.rejects(() => pending, /disconnected|closed/);
});
