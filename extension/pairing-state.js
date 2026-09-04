import { verifyBridgeEnvelopeAuth } from "./bridge-auth.js";

const STORAGE_KEY = "orchordsNativeBridgePairing";

function defaultInstallId() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
}

function isInstallId(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function isPairing(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof value.pairingId === "string" &&
      value.pairingId.length > 0 &&
      typeof value.secret === "string" &&
      /^[A-Za-z0-9_-]{43}$/.test(value.secret) &&
      Number.isInteger(value.generation) &&
      value.generation >= 1,
  );
}

function splitAuthenticatedMessage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new Error("invalid native pairing response");
  }
  const { auth, ...envelope } = message;
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) {
    throw new Error("native pairing response is unauthenticated");
  }
  return { auth, envelope };
}

export async function loadOrCreatePairingState(storageArea, createInstallId = defaultInstallId) {
  const stored = await storageArea.get(STORAGE_KEY);
  const candidate = stored?.[STORAGE_KEY];
  if (candidate && typeof candidate === "object" && isInstallId(candidate.installId)) {
    if (candidate.pairing === undefined || isPairing(candidate.pairing)) {
      return { installId: candidate.installId, pairing: candidate.pairing };
    }
  }

  const state = { installId: createInstallId(), pairing: undefined };
  if (!isInstallId(state.installId)) throw new Error("generated extension install id is invalid");
  await storageArea.set({ [STORAGE_KEY]: state });
  return state;
}

export function createPairingHelloPayload(state) {
  return {
    installId: state.installId,
    ...(state.pairing ? { pairingId: state.pairing.pairingId } : {}),
  };
}

export async function acceptPairingResponse(storageArea, state, message) {
  const { auth, envelope } = splitAuthenticatedMessage(message);
  if (!envelope.payload || typeof envelope.payload !== "object" || Array.isArray(envelope.payload)) {
    throw new Error("invalid native pairing response");
  }
  const payload = envelope.payload;
  if (payload.installId !== state.installId) throw new Error("native pairing response install id mismatch");

  if (envelope.type === "bridge.paired") {
    const pairing = {
      pairingId: payload.pairingId,
      secret: payload.secret,
      generation: payload.generation,
    };
    if (!isPairing(pairing)) throw new Error("invalid native pairing credential");
    if (!(await verifyBridgeEnvelopeAuth(pairing, envelope, auth))) {
      throw new Error("native pairing response authentication failed");
    }
    const next = { installId: state.installId, pairing };
    await storageArea.set({ [STORAGE_KEY]: next });
    return next;
  }

  if (envelope.type === "bridge.ready") {
    if (!state.pairing) throw new Error("native bridge resumed without a local pairing credential");
    if (payload.pairingId !== state.pairing.pairingId || payload.generation !== state.pairing.generation) {
      throw new Error("native bridge pairing generation mismatch");
    }
    if (!(await verifyBridgeEnvelopeAuth(state.pairing, envelope, auth))) {
      throw new Error("native bridge ready authentication failed");
    }
    return state;
  }

  throw new Error("unexpected native pairing response type");
}

export { STORAGE_KEY };
