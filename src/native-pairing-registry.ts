import type { PairingState } from "./native-pairing-store.js";
import {
  createPairing,
  revokePairing,
  rotatePairing,
  type PairingBinding,
  type PairingCredential,
  type PairingRecord,
} from "./native-pairing.js";

interface RegistryOptions {
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
  randomUUID?: () => string;
}

interface HelloInput extends PairingBinding {
  pairingId?: string;
}

interface HelloResult {
  kind: "paired" | "resumed";
  record: PairingRecord;
  credential?: PairingCredential;
}

function sameBinding(record: PairingRecord, binding: PairingBinding): boolean {
  return (
    record.callerOrigin === binding.callerOrigin &&
    record.installId === binding.installId &&
    record.profileId === binding.profileId
  );
}

function assertBinding(record: PairingRecord, binding: PairingBinding): void {
  if (!sameBinding(record, binding)) throw new Error("pairing binding mismatch");
}

export class PairingRegistry {
  private readonly records = new Map<string, PairingRecord>();
  private readonly now: () => number;
  private readonly randomBytes?: (size: number) => Buffer;
  private readonly randomUUID?: () => string;

  constructor(state: PairingState, options: RegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.randomBytes = options.randomBytes;
    this.randomUUID = options.randomUUID;
    for (const record of state.records) this.records.set(record.pairingId, { ...record });
  }

  get(pairingId: string): PairingRecord | undefined {
    const record = this.records.get(pairingId);
    return record ? { ...record } : undefined;
  }

  snapshot(): PairingState {
    return { version: 1, records: [...this.records.values()].map((record) => ({ ...record })) };
  }

  hello(input: HelloInput): HelloResult {
    if (input.pairingId) {
      const record = this.records.get(input.pairingId);
      if (!record) throw new Error("unknown pairing");
      assertBinding(record, input);
      if (record.status !== "active") throw new Error("pairing revoked");
      return { kind: "resumed", record: { ...record } };
    }

    for (const [id, record] of this.records) {
      if (
        record.status === "active" &&
        record.callerOrigin === input.callerOrigin &&
        record.profileId === input.profileId &&
        record.installId !== input.installId
      ) {
        this.records.set(id, revokePairing(record, this.now()));
      }
    }

    let created: ReturnType<typeof createPairing> | undefined;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = createPairing({
        callerOrigin: input.callerOrigin,
        installId: input.installId,
        profileId: input.profileId,
        now: this.now,
        randomBytes: this.randomBytes,
        randomUUID: this.randomUUID,
      });
      if (!this.records.has(candidate.record.pairingId)) {
        created = candidate;
        break;
      }
    }
    if (!created) throw new Error("unable to allocate unique pairing id");
    this.records.set(created.record.pairingId, created.record);
    return { kind: "paired", record: { ...created.record }, credential: created.credential };
  }

  rotate(pairingId: string, binding: PairingBinding): { record: PairingRecord; credential: PairingCredential } {
    const record = this.records.get(pairingId);
    if (!record) throw new Error("unknown pairing");
    assertBinding(record, binding);
    if (record.status !== "active") throw new Error("pairing revoked");
    const rotated = rotatePairing(record, { now: this.now, randomBytes: this.randomBytes });
    this.records.set(pairingId, rotated.record);
    return { record: { ...rotated.record }, credential: rotated.credential };
  }

  revoke(pairingId: string, binding: PairingBinding): PairingRecord {
    const record = this.records.get(pairingId);
    if (!record) throw new Error("unknown pairing");
    assertBinding(record, binding);
    const revoked = revokePairing(record, this.now());
    this.records.set(pairingId, revoked);
    return { ...revoked };
  }
}
