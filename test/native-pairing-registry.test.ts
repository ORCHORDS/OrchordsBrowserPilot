import assert from "node:assert/strict";
import test from "node:test";

import { PairingRegistry } from "../src/native-pairing-registry.js";

const origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/";
const profileId = "profile-a";
let uuid = 0;
let byte = 1;
const registry = () =>
  new PairingRegistry(
    { version: 1, records: [] },
    {
      now: () => 1_000,
      randomUUID: () => `pair-${++uuid}`,
      randomBytes: (size: number) => Buffer.alloc(size, byte++),
    },
  );

test("first hello pairs, same install resumes, unknown claimed pairing is rejected (#123)", () => {
  const r = registry();
  const first = r.hello({ callerOrigin: origin, installId: "install-a", profileId });
  assert.equal(first.kind, "paired");
  assert.ok(first.credential?.secret);
  const resumed = r.hello({
    callerOrigin: origin,
    installId: "install-a",
    profileId,
    pairingId: first.record.pairingId,
  });
  assert.equal(resumed.kind, "resumed");
  assert.equal(resumed.credential, undefined);
  assert.throws(
    () => r.hello({ callerOrigin: origin, installId: "install-a", profileId, pairingId: "missing" }),
    /unknown pairing/i,
  );
});

test("reinstall revokes prior active install and creates a fresh pairing (#123)", () => {
  const r = registry();
  const first = r.hello({ callerOrigin: origin, installId: "install-a", profileId });
  const second = r.hello({ callerOrigin: origin, installId: "install-b", profileId });
  assert.equal(second.kind, "paired");
  assert.notEqual(second.record.pairingId, first.record.pairingId);
  assert.equal(r.get(first.record.pairingId)?.status, "revoked");
  assert.equal(r.get(second.record.pairingId)?.status, "active");
});

test("rotation advances generation and revoke is terminal (#123)", () => {
  const r = registry();
  const first = r.hello({ callerOrigin: origin, installId: "install-a", profileId });
  const rotated = r.rotate(first.record.pairingId, {
    callerOrigin: origin,
    installId: "install-a",
    profileId,
  });
  assert.equal(rotated.record.generation, 2);
  assert.ok(rotated.credential.secret);
  r.revoke(first.record.pairingId, { callerOrigin: origin, installId: "install-a", profileId });
  assert.equal(r.get(first.record.pairingId)?.status, "revoked");
  assert.throws(
    () => r.rotate(first.record.pairingId, { callerOrigin: origin, installId: "install-a", profileId }),
    /revoked/i,
  );
});

test("pairing id collisions never overwrite an existing record (#123)", () => {
  const r = new PairingRegistry(
    { version: 1, records: [] },
    {
      now: () => 1_000,
      randomUUID: () => "same-id",
      randomBytes: (size: number) => Buffer.alloc(size, 9),
    },
  );
  const first = r.hello({ callerOrigin: origin, installId: "install-a", profileId });
  assert.equal(first.record.pairingId, "same-id");
  assert.throws(
    () => r.hello({ callerOrigin: origin, installId: "install-b", profileId }),
    /unique pairing id/i,
  );
  assert.equal(r.get("same-id")?.installId, "install-a");
});
