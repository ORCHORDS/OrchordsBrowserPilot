// Visible agent-control state machine (#125).
//
// The state machine is the single source of truth for what the extension
// tells the user and the page chrome is doing on the user's behalf. Every
// transition is auditable and every user-initiated override (pause, stop,
// disconnect, takeover, resume) is recorded so a replay can reconstruct
// the exact sequence. Page content cannot influence this machine directly;
// only the privileged service worker can call `apply()`, and only after
// either a native-bridge signal or a user-action message has been received.
//
// States (per #125 acceptance criteria):
//   disconnected   — extension is installed but the local bridge is offline.
//   connected-idle — bridge is paired and authenticated, no active operation.
//   observing      — bridge is reading from the attached tab (snapshot, network, console).
//   controlling    — bridge is mutating the attached tab (navigate, click, type).
//   approval-required — bridge needs a high-impact user approval before it can proceed.
//   human-control  — a takeover has been asserted; the agent MUST NOT dispatch actions.
//   error          — the bridge is paired but the most recent operation failed terminally.
//
// Audit log:
//   - Each transition appends an entry { at, from, to, reason, by }.
//   - The log is capped to AUDIT_LIMIT entries (FIFO drop) so storage cannot grow unbounded.
//   - Audit entries are replay-safe: each carries the next-state monotonic counter,
//     which the audit consumer uses to detect tampering or missing entries.

export const CONTROL_STATES = Object.freeze({
  DISCONNECTED: "disconnected",
  CONNECTED_IDLE: "connected-idle",
  OBSERVING: "observing",
  CONTROLLING: "controlling",
  APPROVAL_REQUIRED: "approval-required",
  HUMAN_CONTROL: "human-control",
  ERROR: "error",
});

export const CONTROL_ACTIONS = Object.freeze({
  PAUSE: "pause",
  STOP: "stop",
  DISCONNECT: "disconnect",
  TAKEOVER: "takeover",
  RESUME: "resume",
  APPROVE: "approve",
  DENY: "deny",
});

// Caller identity on every event. `system` = the privileged service worker
// reacting to a bridge signal; `user` = the user pressing a button in the
// popup; `page` is intentionally absent — page content is never authoritative.
export const ACTOR = Object.freeze({
  SYSTEM: "system",
  USER: "user",
});

const VALID_TRANSITIONS = Object.freeze({
  disconnected: new Set(["connected-idle", "error"]),
  "connected-idle": new Set([
    "observing",
    "controlling",
    "approval-required",
    "human-control",
    "disconnected",
    "error",
  ]),
  observing: new Set([
    "connected-idle",
    "controlling",
    "approval-required",
    "human-control",
    "disconnected",
    "error",
  ]),
  controlling: new Set([
    "connected-idle",
    "observing",
    "approval-required",
    "human-control",
    "disconnected",
    "error",
  ]),
  "approval-required": new Set([
    "controlling",
    "connected-idle",
    "human-control",
    "disconnected",
    "error",
  ]),
  "human-control": new Set(["connected-idle", "disconnected", "error"]),
  error: new Set(["connected-idle", "disconnected"]),
});

const AUDIT_LIMIT = 64;

function clampAudit(log) {
  if (!Array.isArray(log)) return [];
  if (log.length <= AUDIT_LIMIT) return log.slice();
  return log.slice(log.length - AUDIT_LIMIT);
}

function isState(value) {
  return Object.values(CONTROL_STATES).includes(value);
}

function defaultNow() {
  return Date.now();
}

export function createControlState(options = {}) {
  const now = options.now ?? defaultNow;
  const audit = clampAudit(options.audit);
  let state = isState(options.initial) ? options.initial : CONTROL_STATES.DISCONNECTED;
  let monotonic = Number.isInteger(options.monotonic) && options.monotonic >= 0 ? options.monotonic : 0;
  // Approval tokens invalidated by pause / stop / disconnect / takeover / deny.
  // Stored as a set; exposed as `invalidatedApprovals` for the bridge client
  // to consume before each dispatch (per #125 stale-approval invalidation).
  const invalidatedApprovals = new Set(options.invalidatedApprovals ?? []);

  function recordTransition(from, to, actor, reason) {
    monotonic += 1;
    audit.push({
      monotonic,
      at: now(),
      from,
      to,
      actor,
      reason: typeof reason === "string" ? reason : "",
    });
    if (audit.length > AUDIT_LIMIT) audit.splice(0, audit.length - AUDIT_LIMIT);
  }

  function apply(event) {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      throw new Error("control-state event is malformed");
    }
    const { type, actor = ACTOR.SYSTEM, reason = "" } = event;
    if (typeof type !== "string" || !type) throw new Error("control-state event type is required");
    if (actor !== ACTOR.SYSTEM && actor !== ACTOR.USER) {
      throw new Error("control-state event actor is invalid");
    }

    switch (type) {
      case "bridge.connected":
        if (state !== CONTROL_STATES.DISCONNECTED) return { state, changed: false, monotonic };
        recordTransition(state, CONTROL_STATES.CONNECTED_IDLE, actor, reason || "bridge paired");
        state = CONTROL_STATES.CONNECTED_IDLE;
        return { state, changed: true, monotonic };

      case "bridge.disconnected":
        if (
          state === CONTROL_STATES.DISCONNECTED ||
          state === CONTROL_STATES.HUMAN_CONTROL
        ) {
          return { state, changed: false, monotonic };
        }
        recordTransition(state, CONTROL_STATES.DISCONNECTED, actor, reason || "bridge disconnected");
        state = CONTROL_STATES.DISCONNECTED;
        return { state, changed: true, monotonic };

      case "bridge.observing":
        if (state === CONTROL_STATES.OBSERVING) return { state, changed: false, monotonic };
        if (!VALID_TRANSITIONS[state].has(CONTROL_STATES.OBSERVING)) {
          throw new Error(`cannot enter observing from ${state}`);
        }
        recordTransition(state, CONTROL_STATES.OBSERVING, actor, reason || "bridge began observing");
        state = CONTROL_STATES.OBSERVING;
        return { state, changed: true, monotonic };

      case "bridge.controlling":
        if (state === CONTROL_STATES.CONTROLLING) return { state, changed: false, monotonic };
        if (!VALID_TRANSITIONS[state].has(CONTROL_STATES.CONTROLLING)) {
          throw new Error(`cannot enter controlling from ${state}`);
        }
        recordTransition(state, CONTROL_STATES.CONTROLLING, actor, reason || "bridge began controlling");
        state = CONTROL_STATES.CONTROLLING;
        return { state, changed: true, monotonic };

      case "bridge.idle":
        if (state === CONTROL_STATES.CONNECTED_IDLE) return { state, changed: false, monotonic };
        if (!VALID_TRANSITIONS[state].has(CONTROL_STATES.CONNECTED_IDLE)) {
          throw new Error(`cannot return to idle from ${state}`);
        }
        recordTransition(state, CONTROL_STATES.CONNECTED_IDLE, actor, reason || "bridge idle");
        state = CONTROL_STATES.CONNECTED_IDLE;
        return { state, changed: true, monotonic };

      case "bridge.approval_required":
        if (state === CONTROL_STATES.APPROVAL_REQUIRED) return { state, changed: false, monotonic };
        if (!VALID_TRANSITIONS[state].has(CONTROL_STATES.APPROVAL_REQUIRED)) {
          throw new Error(`cannot request approval from ${state}`);
        }
        recordTransition(state, CONTROL_STATES.APPROVAL_REQUIRED, actor, reason || "approval required");
        state = CONTROL_STATES.APPROVAL_REQUIRED;
        return { state, changed: true, monotonic };

      case "bridge.error":
        recordTransition(state, CONTROL_STATES.ERROR, actor, reason || "bridge error");
        state = CONTROL_STATES.ERROR;
        return { state, changed: true, monotonic };

      case CONTROL_ACTIONS.PAUSE: {
        // Pause: halt autonomous mutation immediately and return to idle
        // without disconnecting. In-flight/queued semantics live in #104;
        // this machine only records the user override. Pause is a no-op from
        // idle, and is refused from disconnected / human-control (stop or
        // resume are the correct actions there).
        const pausable = new Set([
          CONTROL_STATES.OBSERVING,
          CONTROL_STATES.CONTROLLING,
          CONTROL_STATES.APPROVAL_REQUIRED,
          CONTROL_STATES.ERROR,
        ]);
        if (state === CONTROL_STATES.CONNECTED_IDLE) return { state, changed: false, monotonic };
        if (!pausable.has(state)) {
          throw new Error(`cannot pause from ${state}`);
        }
        invalidatedApprovals.add(`pause@${now()}`);
        recordTransition(state, CONTROL_STATES.CONNECTED_IDLE, actor, reason || "user paused");
        state = CONTROL_STATES.CONNECTED_IDLE;
        return { state, changed: true, monotonic };
      }

      case CONTROL_ACTIONS.STOP: {
        // Stop: terminate the session AND revoke bridge authority. The
        // service worker must clear pairing credentials and reconnect cold.
        if (state === CONTROL_STATES.DISCONNECTED) return { state, changed: false, monotonic };
        invalidatedApprovals.add(`stop@${now()}`);
        recordTransition(state, CONTROL_STATES.DISCONNECTED, actor, reason || "user stopped");
        state = CONTROL_STATES.DISCONNECTED;
        return { state, changed: true, monotonic };
      }

      case CONTROL_ACTIONS.DISCONNECT: {
        if (state === CONTROL_STATES.DISCONNECTED) return { state, changed: false, monotonic };
        invalidatedApprovals.add(`disconnect@${now()}`);
        recordTransition(state, CONTROL_STATES.DISCONNECTED, actor, reason || "user disconnected");
        state = CONTROL_STATES.DISCONNECTED;
        return { state, changed: true, monotonic };
      }

      case CONTROL_ACTIONS.TAKEOVER: {
        // Takeover: hand control to the human. The agent MUST NOT dispatch
        // any further action until a `resume` event arrives. Stale approvals
        // are invalidated so a subsequent resume requires re-approval.
        if (state === CONTROL_STATES.HUMAN_CONTROL) return { state, changed: false, monotonic };
        if (!VALID_TRANSITIONS[state].has(CONTROL_STATES.HUMAN_CONTROL)) {
          throw new Error(`cannot takeover from ${state}`);
        }
        invalidatedApprovals.add(`takeover@${now()}`);
        recordTransition(state, CONTROL_STATES.HUMAN_CONTROL, actor, reason || "human takeover");
        state = CONTROL_STATES.HUMAN_CONTROL;
        return { state, changed: true, monotonic };
      }

      case CONTROL_ACTIONS.RESUME: {
        if (state !== CONTROL_STATES.HUMAN_CONTROL) {
          throw new Error(`cannot resume from ${state}`);
        }
        recordTransition(state, CONTROL_STATES.CONNECTED_IDLE, actor, reason || "human resumed");
        state = CONTROL_STATES.CONNECTED_IDLE;
        return { state, changed: true, monotonic };
      }

      case CONTROL_ACTIONS.APPROVE: {
        if (state !== CONTROL_STATES.APPROVAL_REQUIRED) {
          throw new Error(`cannot approve from ${state}`);
        }
        recordTransition(state, CONTROL_STATES.CONTROLLING, actor, reason || "user approved");
        state = CONTROL_STATES.CONTROLLING;
        return { state, changed: true, monotonic };
      }

      case CONTROL_ACTIONS.DENY: {
        if (state !== CONTROL_STATES.APPROVAL_REQUIRED) {
          throw new Error(`cannot deny from ${state}`);
        }
        invalidatedApprovals.add(`deny@${now()}`);
        recordTransition(state, CONTROL_STATES.CONNECTED_IDLE, actor, reason || "user denied");
        state = CONTROL_STATES.CONNECTED_IDLE;
        return { state, changed: true, monotonic };
      }

      default:
        throw new Error(`unknown control-state event type: ${type}`);
    }
  }

  function isApprovalValid(approvalId) {
    if (typeof approvalId !== "string" || !approvalId) return false;
    return !invalidatedApprovals.has(approvalId);
  }

  function invalidateApproval(approvalId) {
    if (typeof approvalId !== "string" || !approvalId) return false;
    if (invalidatedApprovals.has(approvalId)) return false;
    invalidatedApprovals.add(approvalId);
    return true;
  }

  function snapshot() {
    return {
      state,
      monotonic,
      audit: audit.slice(),
      invalidatedApprovals: Array.from(invalidatedApprovals),
    };
  }

  function badgeText() {
    switch (state) {
      case CONTROL_STATES.DISCONNECTED:
        return "OFF";
      case CONTROL_STATES.CONNECTED_IDLE:
        return "";
      case CONTROL_STATES.OBSERVING:
        return "EYE";
      case CONTROL_STATES.CONTROLLING:
        return "ACT";
      case CONTROL_STATES.APPROVAL_REQUIRED:
        return "?";
      case CONTROL_STATES.HUMAN_CONTROL:
        return "ME";
      case CONTROL_STATES.ERROR:
        return "ERR";
      default:
        return "";
    }
  }

  function badgeColor() {
    switch (state) {
      case CONTROL_STATES.DISCONNECTED:
        return "#7a7a7a";
      case CONTROL_STATES.CONNECTED_IDLE:
        return "#1f8a3b";
      case CONTROL_STATES.OBSERVING:
        return "#1f5fa8";
      case CONTROL_STATES.CONTROLLING:
        return "#b35900";
      case CONTROL_STATES.APPROVAL_REQUIRED:
        return "#8a5a00";
      case CONTROL_STATES.HUMAN_CONTROL:
        return "#6a1b9a";
      case CONTROL_STATES.ERROR:
        return "#a01010";
      default:
        return "#7a7a7a";
    }
  }

  return {
    apply,
    isApprovalValid,
    invalidateApproval,
    snapshot,
    badgeText,
    badgeColor,
    get state() {
      return state;
    },
    get monotonic() {
      return monotonic;
    },
  };
}

export const AUDIT_LIMIT_EXPORT = AUDIT_LIMIT;
