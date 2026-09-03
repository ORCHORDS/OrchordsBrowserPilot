import assert from "node:assert/strict";
import test from "node:test";

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

test("extension creates one stable local install id and hello never sends the secret (#123)", async () => {
  const area = storage();
  const first = await loadOrCreatePairingState(area, () => installId);
  const second = await loadOrCreatePairingState(area, () => "b".repeat(64));
  assert.equal(first.installId, installId);
  assert.equal(second.installId, installId);
  assert.deepEqual(createPairingHelloPayload(first), { installId });
});

test("paired response is stored locally and reconnect hello exposes only pairing id (#123)", async () => {
  const area = storage({ [STORAGE_KEY]: { installId } });
  const state = await loadOrCreatePairingState(area);
  const paired = await acceptPairingResponse(area, state, {
    type: "bridge.paired",
    payload: {
      installId,
      pairingId: "pair-1",
      generation: 1,
      secret: "A".repeat(43),
    },
  });
  assert.deepEqual(createPairingHelloPayload(paired), { installId, pairingId: "pair-1" });
  assert.equal((createPairingHelloPayload(paired) as Record<string, unknown>).secret, undefined);
  assert.equal(
    ((area.snapshot()[STORAGE_KEY] as { pairing: { secret: string } }).pairing.secret),
    "A".repeat(43),
  );
});

test("bridge resume requires the exact local pairing generation and install id (#123)", async () => {
  const area = storage({
    [STORAGE_KEY]: {
      installId,
      pairing: { pairingId: "pair-1", generation: 2, secret: "A".repeat(43) },
    },
  });
  const state = await loadOrCreatePairingState(area);
  await assert.doesNotReject(() =>
    acceptPairingResponse(area, state, {
      type: "bridge.ready",
      payload: { installId, pairingId: "pair-1", generation: 2 },
    }),
  );
  await assert.rejects(
    () =>
      acceptPairingResponse(area, state, {
        type: "bridge.ready",
        payload: { installId, pairingId: "pair-1", generation: 1 },
      }),
    /generation mismatch/i,
  );
  await assert.rejects(
    () =>
      acceptPairingResponse(area, state, {
        type: "bridge.ready",
        payload: { installId: "b".repeat(64), pairingId: "pair-1", generation: 2 },
      }),
    /install id mismatch/i,
  );
});
