// Extension onboarding state machine (#129).
//
// Pure data layer that drives the first-run flow: detection → pairing →
// settings → ready. The state machine is intentionally minimal because the
// heavy lifting (pairing handshake, settings persistence, doctor output) is
// delegated to the already-shipped modules under #123 and #129 itself.
//
// Persistence is shape-compatible with chrome.storage.local. The service
// worker is the sole writer; the popup reads snapshots over the same
// control-state:update broadcast that #125 uses.

const STORAGE_KEY = "orchordsOnboardingState";

export const ONBOARDING_STAGES = Object.freeze({
  UNKNOWN: "unknown",
  DETECT_CORE: "detect-core",
  PAIR: "pair",
  SETTINGS: "settings",
  READY: "ready",
});

const STAGE_ORDER = Object.freeze([
  ONBOARDING_STAGES.UNKNOWN,
  ONBOARDING_STAGES.DETECT_CORE,
  ONBOARDING_STAGES.PAIR,
  ONBOARDING_STAGES.SETTINGS,
  ONBOARDING_STAGES.READY,
]);

const TRANSITIONS = Object.freeze({
  // UNKNOWN is the first-run state; it can advance linearly into the
  // wizard, skip ahead if the user has already paired with another tool,
  // or skip straight to READY if everything is already configured.
  [ONBOARDING_STAGES.UNKNOWN]: [
    ONBOARDING_STAGES.DETECT_CORE,
    ONBOARDING_STAGES.PAIR,
    ONBOARDING_STAGES.SETTINGS,
    ONBOARDING_STAGES.READY,
  ],
  [ONBOARDING_STAGES.DETECT_CORE]: [
    ONBOARDING_STAGES.PAIR,
    ONBOARDING_STAGES.READY,
  ],
  [ONBOARDING_STAGES.PAIR]: [
    ONBOARDING_STAGES.SETTINGS,
    ONBOARDING_STAGES.DETECT_CORE,
  ],
  [ONBOARDING_STAGES.SETTINGS]: [
    ONBOARDING_STAGES.READY,
    ONBOARDING_STAGES.PAIR,
  ],
  [ONBOARDING_STAGES.READY]: [ONBOARDING_STAGES.PAIR],
});

function isStage(value) {
  return typeof value === "string" && Object.values(ONBOARDING_STAGES).includes(value);
}

function createState({ stage = ONBOARDING_STAGES.UNKNOWN, completed = [] } = {}) {
  const seen = new Set();
  for (const s of completed) {
    if (isStage(s)) seen.add(s);
  }
  return {
    stage: isStage(stage) ? stage : ONBOARDING_STAGES.UNKNOWN,
    completed: Array.from(seen),
  };
}

export function loadOnboardingState(stored) {
  const candidate = stored?.[STORAGE_KEY];
  return createState({
    stage: candidate?.stage,
    completed: Array.isArray(candidate?.completed) ? candidate.completed : [],
  });
}

export function defaultOnboardingState() {
  return createState({ stage: ONBOARDING_STAGES.UNKNOWN, completed: [] });
}

function nextStage(stage) {
  const idx = STAGE_ORDER.indexOf(stage);
  if (idx < 0 || idx >= STAGE_ORDER.length - 1) return null;
  return STAGE_ORDER[idx + 1];
}

export function advanceOnboarding(state) {
  if (!state || typeof state !== "object") {
    throw new Error("invalid onboarding state");
  }
  const next = nextStage(state.stage);
  if (!next) {
    return { changed: false, state };
  }
  const completed = new Set(state.completed ?? []);
  completed.add(state.stage);
  return {
    changed: true,
    state: createState({ stage: next, completed: Array.from(completed) }),
  };
}

export function transitionOnboarding(state, targetStage) {
  if (!state || typeof state !== "object") {
    throw new Error("invalid onboarding state");
  }
  if (!isStage(targetStage)) {
    throw new Error(`unknown onboarding stage: ${String(targetStage)}`);
  }
  if (state.stage === targetStage) {
    return { changed: false, state };
  }
  const allowed = TRANSITIONS[state.stage] ?? [];
  if (!allowed.includes(targetStage)) {
    throw new Error(
      `invalid onboarding transition: ${state.stage} → ${targetStage}`,
    );
  }
  const completed = new Set(state.completed ?? []);
  completed.add(state.stage);
  return {
    changed: true,
    state: createState({ stage: targetStage, completed: Array.from(completed) }),
  };
}

export function resetOnboarding() {
  return createState({ stage: ONBOARDING_STAGES.UNKNOWN, completed: [] });
}

export async function persistOnboardingState(storageArea, state) {
  const next = state && typeof state === "object" ? state : defaultOnboardingState();
  await storageArea.set({ [STORAGE_KEY]: next });
  return next;
}

export const ONBOARDING_STORAGE_KEY = STORAGE_KEY;

export const ONBOARDING_VERSION = 1;
