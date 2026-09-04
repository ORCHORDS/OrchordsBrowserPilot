import assert from "node:assert/strict";
import test from "node:test";

import { signBridgeEnvelope } from "../extension/bridge-auth.js";
import {
  STORAGE_KEY,
  acceptPairingResponse,
  createPairingHelloPayload,
  loadOrCreatePairingState,
} from "../extension/pairing-state.js";

function storage(initial = {}) {
  const data = { ...initial };
  return {
    async get(key: string) {
      return { [key]: data[key as keyof typeof data] };
    },
    async set(value: Record<string, unknown>) {
      Object.assign(data, value);
    },
    snapshot() {
      return data as Record<string, unknown>;
    },
  };
}

const installId = "a".repeat(64);
const pairing = { pairingId: "pair-1", generation: 1, secret: "A".repeat(43) };

async function signedMessage(type: string, payload: Record<string, unknown>, credential = pairing) {
  const envelope = {
    protocol: 1,
    id: "11111111-1111-4111-8111-111111111111",
    nonce: "b".repeat(64),
    deadlineAt: 30_000,
    type,
    payload,
  };
  return { ...envelope, auth: await signBridgeEnvelope(credential, envelope) };
}

test("extension creates one stable local install id and hello never sends the secret (#123)", async () => {
  const area = storage();
  const first = await loadOrCreatePairingState(area, () => installId);
  const second = await loadOrCreatePairingState(area, () => "b".repeat(64));
  assert.equal(first.installId, installId);
  assert.equal(second.installId, installId);
  assert.deepEqual(createPairingHelloPayload(first), { installId });
});

test("authenticated paired response is verified before local credential storage (#123)", async () => {
  const area = storage({ [STORAGE_KEY]: { installId } });
  const state = await loadOrCreatePairingState(area);
  const message = await signedMessage("bridge.paired", {
    installId,
    pairingId: pairing.pairingId,
    generation: pairing.generation,
    secret: pairing.secret,
  });
  const paired = await acceptPairingResponse(area, state, message);
  assert.deepEqual(createPairingHelloPayload(paired), { installId, pairingId: "pair-1" });
  assert.equal((createPairingHelloPayload(paired) as Record<string, unknown>).secret, undefined);
  assert.equal(
    ((area.snapshot()[STORAGE_KEY] as { pairing: { secret: string } }).pairing.secret),
    pairing.secret,
  );
});

test("tampered first-pair response is rejected before storage (#123)", async () => {
  const area = storage({ [STORAGE_KEY]: { installId } });
  const state = await loadOrCreatePairingState(area);
  const message = await signedMessage("bridge.paired", {
    installId,
    pairingId: pairing.pairingId,
    generation: pairing.generation,
    secret: pairing.secret,
  });
  message.payload.generation = 2;
  await assert.rejects(() => acceptPairingResponse(area, state, message), /authentication failed/i);
  assert.equal((area.snapshot()[STORAGE_KEY] as { pairing?: unknown }).pairing, undefined);
});

test("bridge resume requires exact generation, install id, and authenticated host response (#123)", async () => {
  const current = { pairingId: "pair-1", generation: 2, secret: "A".repeat(43) };
  const area = storage({ [STORAGE_KEY]: { installId, pairing: current } });
  const state = await loadOrCreatePairingState(area);
  const ready = await signedMessage("bridge.ready", { installId, pairingId: "pair-1", generation: 2 }, current);
  await assert.doesNotReject(() => acceptPairingResponse(area, state, ready));

  const stale = await signedMessage("bridge.ready", { installId, pairingId: "pair-1", generation: 1 }, current);
  await assert.rejects(() => acceptPairingResponse(area, state, stale), /generation mismatch/i);

  const wrongInstall = await signedMessage(
    "bridge.ready",
    { installId: "b".repeat(64), pairingId: "pair-1", generation: 2 },
    current,
  );
  await assert.rejects(() => acceptPairingResponse(area, state, wrongInstall), /install id mismatch/i);

  const tampered = await signedMessage("bridge.ready", { installId, pairingId: "pair-1", generation: 2 }, current);
  tampered.payload.extra = "tampered";
  await assert.rejects(() => acceptPairingResponse(area, state, tampered), /authentication failed/i);
});
