import assert from "node:assert/strict";
import test from "node:test";

import { attachBridgeAuth, verifyBridgeEnvelopeAuth } from "../extension/bridge-auth.js";
import { AuthenticatedBridgeClient } from "../extension/bridge-client.js";
import { createBridgeEnvelope } from "../extension/bridge-protocol.js";

const pairing = { pairingId: "pair-1", generation: 2, secret: "A".repeat(43) };

function envelopeOptions() {
  let counter = 0;
  return {
    now: () => 1_000,
    randomUUID: () => {
      counter += 1;
      return `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
    },
    randomNonce: () => String(counter + 1).padStart(64, "a"),
    ttlMs: 30_000,
  };
}

function mockPort() {
  const messages: unknown[] = [];
  return {
    messages,
    postMessage(message: unknown) {
      messages.push(message);
    },
  };
}

async function signedHostMessage(type: string, payload: Record<string, unknown>, id: string) {
  const envelope = createBridgeEnvelope(type, payload, {
    now: () => 1_000,
    randomUUID: () => id,
    randomNonce: () => "b".repeat(64),
    ttlMs: 30_000,
  });
  return { ...envelope, auth: await attachBridgeAuth(pairing, envelope).then(message => message.auth) };
}

test("authenticated bridge client signs a correlated tool request and resolves only a signed response (#123)", async () => {
  const port = mockPort();
  const client = new AuthenticatedBridgeClient(port, pairing, { envelopeOptions: envelopeOptions() });
  const started = await client.startRequest("browser_console", { level: "log", limit: 10 });
  assert.equal(port.messages.length, 1);
  const outbound = port.messages[0] as Record<string, unknown>;
  const { auth, ...unsigned } = outbound as { auth: { pairingId: string; generation: number; mac: string } } & Record<string, unknown>;
  assert.equal(await verifyBridgeEnvelopeAuth(pairing, unsigned, auth), true);
  assert.equal((unsigned.payload as { tool: string }).tool, "browser_console");

  const response = await signedHostMessage(
    "bridge.response",
    { requestId: started.requestId, result: { messages: [] } },
    "11111111-1111-4111-8111-111111111111",
  );
  assert.equal(await client.handleMessage(response), true);
  assert.deepEqual(await started.response, { messages: [] });
});

test("authenticated bridge client rejects tampered responses without consuming the pending request (#123)", async () => {
  const port = mockPort();
  const client = new AuthenticatedBridgeClient(port, pairing, { envelopeOptions: envelopeOptions() });
  const started = await client.startRequest("browser_snapshot", {});
  const response = await signedHostMessage(
    "bridge.response",
    { requestId: started.requestId, result: "ok" },
    "22222222-2222-4222-8222-222222222222",
  );
  response.payload.result = "tampered";
  await assert.rejects(() => client.handleMessage(response), /authentication failed/i);

  const good = await signedHostMessage(
    "bridge.response",
    { requestId: started.requestId, result: "ok" },
    "33333333-3333-4333-8333-333333333333",
  );
  assert.equal(await client.handleMessage(good), true);
  assert.equal(await started.response, "ok");
});

test("authenticated bridge client signs cancellation and disconnect rejects every pending request (#123)", async () => {
  const port = mockPort();
  const client = new AuthenticatedBridgeClient(port, pairing, { envelopeOptions: envelopeOptions() });
  const first = await client.startRequest("browser_wait", { ms: 1000 });
  const second = await client.startRequest("browser_wait", { ms: 1000 });
  await client.cancel(first.requestId);
  const cancel = port.messages[2] as Record<string, unknown>;
  const { auth, ...unsigned } = cancel as { auth: { pairingId: string; generation: number; mac: string } } & Record<string, unknown>;
  assert.equal(unsigned.type, "bridge.cancel");
  assert.equal((unsigned.payload as { requestId: string }).requestId, first.requestId);
  assert.equal(await verifyBridgeEnvelopeAuth(pairing, unsigned, auth), true);

  client.disconnect("native host exited");
  await assert.rejects(first.response, /native host exited/i);
  await assert.rejects(second.response, /native host exited/i);
});
