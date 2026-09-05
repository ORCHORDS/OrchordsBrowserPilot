// Service-worker lifecycle hardening (#130).
//
// MV3 service workers are suspended after ~30s of inactivity and may be
// killed at any time. The bridge to the native host must therefore:
//
//   - wake up on a reliable trigger (`chrome.alarms`, `chrome.runtime`
//     events, and user gestures),
//   - resume any in-flight envelopes after wakeup using
//     `chrome.storage.session` as a small FIFO,
//   - reconnect to the native host on a backoff schedule,
//   - keep the heartbeat alive while an active session is in progress.
//
// This module is pure (no `chrome.*` at import time). Tests inject
// `chrome`, an alarm adapter, and a clock.

export const SW_LIFECYCLE_VERSION = 1;

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 45_000;
export const DEFAULT_RECONNECT_BACKOFF_MS = [1_000, 5_000, 15_000, 30_000];
export const SESSION_INFLIGHT_KEY = "orchordsSwInflight";
export const SESSION_HEARTBEAT_KEY = "orchordsSwHeartbeat";
export const SESSION_LAST_ACK_KEY = "orchordsSwLastAck";

export function canonicalEnvelopeId(envelope) {
  if (!envelope || typeof envelope !== "object") return null;
  if (typeof envelope.id === "string" && envelope.id.length > 0) return envelope.id;
  if (typeof envelope.envelopeId === "string") return envelope.envelopeId;
  return null;
}

export function createServiceWorkerLifecycle({
  chromeApi,
  alarmsApi,
  storageSession,
  postEnvelope,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
  heartbeatTimeoutMs = DEFAULT_HEARTBEAT_TIMEOUT_MS,
  reconnectBackoffMs = DEFAULT_RECONNECT_BACKOFF_MS,
} = {}) {
  if (!chromeApi) throw new Error("SWLifecycle requires a chrome-shaped adapter");
  if (typeof postEnvelope !== "function") throw new Error("SWLifecycle requires a postEnvelope function");

  let heartbeatTimer = null;
  let heartbeatStartedAt = null;
  let lastHeartbeatAck = null;
  let reconnectAttempts = 0;
  let wakeupInFlight = false;

  async function loadInflight() {
    const stored = await storageSession?.get?.(SESSION_INFLIGHT_KEY);
    const list = stored?.[SESSION_INFLIGHT_KEY];
    return Array.isArray(list) ? list.slice() : [];
  }

  async function persistInflight(list) {
    await storageSession?.set?.({ [SESSION_INFLIGHT_KEY]: list });
  }

  async function recordHeartbeatAck() {
    lastHeartbeatAck = now();
    await storageSession?.set?.({ [SESSION_LAST_ACK_KEY]: lastHeartbeatAck });
  }

  async function resumeInflight() {
    const inflight = await loadInflight();
    if (inflight.length === 0) return { resumed: 0 };
    let resumed = 0;
    for (const envelope of inflight) {
      if (!canonicalEnvelopeId(envelope)) continue;
      if (Number.isFinite(envelope.deadlineAt) && envelope.deadlineAt < now()) continue;
      const result = postEnvelope(envelope.type, envelope.payload);
      if (result?.ok) resumed += 1;
    }
    await persistInflight(inflight.filter((e) => Number.isFinite(e.deadlineAt) && e.deadlineAt >= now()));
    return { resumed };
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatStartedAt = now();
    heartbeatTimer = setTimer(async () => {
      await recordHeartbeatAck();
      if (lastHeartbeatAck && now() - lastHeartbeatAck > heartbeatTimeoutMs) {
        await triggerReconnect({ reason: "heartbeat_timeout" });
        return;
      }
      const result = postEnvelope("bridge.heartbeat", { at: now() });
      if (!result?.ok) await triggerReconnect({ reason: "post_failed" });
    }, heartbeatIntervalMs);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) clearTimer(heartbeatTimer);
    heartbeatTimer = null;
  }

  async function trackOutbound(envelope) {
    const id = canonicalEnvelopeId(envelope);
    if (!id) return { ok: false, code: "envelope_missing_id" };
    const inflight = await loadInflight();
    if (inflight.some((e) => canonicalEnvelopeId(e) === id)) return { ok: false, code: "duplicate" };
    inflight.push(envelope);
    await persistInflight(inflight);
    return { ok: true, position: inflight.length };
  }

  async function acknowledgeInflight(envelopeId) {
    if (typeof envelopeId !== "string") return;
    const inflight = await loadInflight();
    const remaining = inflight.filter((e) => canonicalEnvelopeId(e) !== envelopeId);
    await persistInflight(remaining);
  }

  async function triggerReconnect({ reason = "scheduled" } = {}) {
    if (wakeupInFlight) return { ok: false, code: "wakeup_in_flight" };
    wakeupInFlight = true;
    try {
      const delay = reconnectBackoffMs[Math.min(reconnectAttempts, reconnectBackoffMs.length - 1)];
      reconnectAttempts += 1;
      await new Promise((resolve) => setTimer(resolve, delay));
      const resumed = await resumeInflight();
      reconnectAttempts = 0;
      startHeartbeat();
      return { ok: true, resumed: resumed.resumed, reason };
    } finally {
      wakeupInFlight = false;
    }
  }

  function registerAlarms() {
    if (!alarmsApi?.create) return;
    alarmsApi.create("orchords.sw.heartbeat", { periodInMinutes: 1 });
    alarmsApi.onAlarm?.addListener?.((alarm) => {
      if (alarm?.name !== "orchords.sw.heartbeat") return;
      void resumeInflight();
    });
  }

  async function onSuspend() {
    stopHeartbeat();
    return { suspended: true, at: now() };
  }

  async function onWakeup() {
    const resumed = await resumeInflight();
    startHeartbeat();
    return { woke: true, resumed: resumed.resumed };
  }

  return {
    startHeartbeat,
    stopHeartbeat,
    trackOutbound,
    acknowledgeInflight,
    triggerReconnect,
    registerAlarms,
    resumeInflight,
    onSuspend,
    onWakeup,
    isHeartbeatActive: () => heartbeatTimer !== null,
    getReconnectAttempts: () => reconnectAttempts,
  };
}
