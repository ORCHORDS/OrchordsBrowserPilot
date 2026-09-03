import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

import type { PairingRecord } from "./native-pairing.js";

export interface PairingState {
  version: 1;
  records: PairingRecord[];
}

function isPairingRecord(value: unknown): value is PairingRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.pairingId === "string" &&
    record.pairingId.length > 0 &&
    typeof record.callerOrigin === "string" &&
    record.callerOrigin.length > 0 &&
    typeof record.installId === "string" &&
    record.installId.length > 0 &&
    typeof record.profileId === "string" &&
    record.profileId.length > 0 &&
    typeof record.secretHash === "string" &&
    /^[a-f0-9]{64}$/i.test(record.secretHash) &&
    Number.isInteger(record.generation) &&
    (record.generation as number) >= 1 &&
    (record.status === "active" || record.status === "revoked") &&
    typeof record.issuedAt === "number" &&
    Number.isFinite(record.issuedAt) &&
    (record.rotatedAt === undefined || (typeof record.rotatedAt === "number" && Number.isFinite(record.rotatedAt))) &&
    (record.revokedAt === undefined || (typeof record.revokedAt === "number" && Number.isFinite(record.revokedAt)))
  );
}

export async function loadPairingState(filePath: string): Promise<PairingState> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, records: [] };
    throw error;
  }

  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("invalid pairing state");
  const state = parsed as Record<string, unknown>;
  if (state.version !== 1 || !Array.isArray(state.records)) throw new Error("invalid pairing state");

  const records: PairingRecord[] = [];
  const ids = new Set<string>();
  for (const candidate of state.records) {
    if (!isPairingRecord(candidate)) throw new Error("invalid pairing record");
    if (ids.has(candidate.pairingId)) throw new Error(`duplicate pairing id: ${candidate.pairingId}`);
    ids.add(candidate.pairingId);
    records.push(candidate);
  }
  return { version: 1, records };
}

export async function savePairingState(filePath: string, state: PairingState): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tempPath = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${randomUUID()}`);
  const payload = `${JSON.stringify(state)}\n`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tempPath, "wx", 0o600);
    await handle.writeFile(payload, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tempPath, filePath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}
