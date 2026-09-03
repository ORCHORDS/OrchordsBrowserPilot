function stableJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("bridge auth payload contains non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  throw new Error(`unsupported bridge auth value type: ${typeof value}`);
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function toHex(bytes) {
  return Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, "0")).join("");
}

async function verifierKey(secret) {
  if (typeof secret !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(secret)) {
    throw new Error("invalid bridge pairing secret");
  }
  const secretBytes = decodeBase64Url(secret);
  const verifier = await crypto.subtle.digest("SHA-256", secretBytes);
  return crypto.subtle.importKey("raw", verifier, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

export async function signBridgeEnvelope(pairing, envelope) {
  if (!pairing || typeof pairing.pairingId !== "string" || !Number.isInteger(pairing.generation)) {
    throw new Error("invalid bridge pairing credential");
  }
  const key = await verifierKey(pairing.secret);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(stableJson(envelope)));
  return {
    pairingId: pairing.pairingId,
    generation: pairing.generation,
    mac: toHex(mac),
  };
}

export async function attachBridgeAuth(pairing, envelope) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) || "auth" in envelope) {
    throw new Error("bridge envelope must be an unauthenticated object");
  }
  return { ...envelope, auth: await signBridgeEnvelope(pairing, envelope) };
}

export { stableJson };
