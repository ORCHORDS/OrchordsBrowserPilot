import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const settingsUrl = pathToFileURL(
  path.join(repoRoot, "extension", "settings.js"),
).href;
const onboardingUrl = pathToFileURL(
  path.join(repoRoot, "extension", "onboarding.js"),
).href;

const settings = await import(settingsUrl);
const onboarding = await import(onboardingUrl);

function fakeStorage(initial = {}) {
  const map = { ...initial };
  return {
    get(key) {
      if (typeof key === "string") return Promise.resolve({ [key]: map[key] });
      if (Array.isArray(key)) {
        const out = {};
        for (const k of key) out[k] = map[k];
        return Promise.resolve(out);
      }
      return Promise.resolve({ ...map });
    },
    set(obj) {
      Object.assign(map, obj);
      return Promise.resolve();
    },
    remove(key) {
      if (typeof key === "string") delete map[key];
      else if (Array.isArray(key)) for (const k of key) delete map[k];
      return Promise.resolve();
    },
    _raw: map,
  };
}

test("settings defaults are stable (#129)", () => {
  const d = settings.defaultSettings();
  assert.equal(d.startupBehavior, "remember");
  assert.equal(d.diagnosticsOptIn, false);
  assert.equal(d.coreEndpoint, "");
  assert.equal(d.interfaceDensity, "default");
});

test("unknown keys are dropped on clean (#129)", () => {
  const result = settings.cleanSettings({
    startupBehavior: "idle",
    diagnosticsOptIn: true,
    interfaceDensity: "compact",
    coreEndpoint: "https://core.example.com/",
    rogueKey: "secret",
    installPath: "/etc/passwd",
  });
  assert.equal(result.startupBehavior, "idle");
  assert.equal(result.diagnosticsOptIn, true);
  assert.equal(result.interfaceDensity, "compact");
  assert.equal(result.coreEndpoint, "https://core.example.com/");
  assert.equal(result.rogueKey, undefined);
  assert.equal(result.installPath, undefined);
});

test("invalid startup behavior and density fall back to defaults (#129)", () => {
  const result = settings.cleanSettings({
    startupBehavior: "explode",
    interfaceDensity: "ultra",
  });
  assert.equal(result.startupBehavior, "remember");
  assert.equal(result.interfaceDensity, "default");
});

test("non-http(s) core endpoint is refused (#129)", () => {
  assert.equal(settings.cleanSettings({ coreEndpoint: "file:///etc/passwd" }).coreEndpoint, "");
  assert.equal(settings.cleanSettings({ coreEndpoint: "javascript:alert(1)" }).coreEndpoint, "");
  assert.equal(settings.cleanSettings({ coreEndpoint: "not a url" }).coreEndpoint, "");
});

test("non-boolean diagnosticsOptIn is refused (#129)", () => {
  assert.equal(settings.cleanSettings({ diagnosticsOptIn: "yes" }).diagnosticsOptIn, false);
  assert.equal(settings.cleanSettings({ diagnosticsOptIn: 1 }).diagnosticsOptIn, false);
  assert.equal(settings.cleanSettings({ diagnosticsOptIn: true }).diagnosticsOptIn, true);
});

test("loadSettings returns defaults when storage is empty (#129)", async () => {
  const storage = fakeStorage();
  const result = await settings.loadSettings(storage);
  assert.deepEqual(result, settings.defaultSettings());
});

test("loadSettings cleans stale values (#129)", async () => {
  const storage = fakeStorage({
    orchordsExtensionSettings: {
      startupBehavior: "idle",
      diagnosticsOptIn: true,
      rogue: "x",
    },
  });
  const result = await settings.loadSettings(storage);
  assert.equal(result.startupBehavior, "idle");
  assert.equal(result.diagnosticsOptIn, true);
  assert.equal(result.rogue, undefined);
});

test("saveSettings writes the canonical shape (#129)", async () => {
  const storage = fakeStorage();
  await settings.saveSettings(storage, { startupBehavior: "idle", rogue: "x" });
  const stored = storage._raw.orchordsExtensionSettings;
  assert.equal(stored.startupBehavior, "idle");
  assert.equal(stored.rogue, undefined);
});

test("settings key allow-list is exported and frozen (#129)", () => {
  assert.ok(settings.SETTINGS_KEY_ALLOWLIST.includes("startupBehavior"));
  assert.ok(settings.SETTINGS_KEY_ALLOWLIST.includes("diagnosticsOptIn"));
  assert.ok(settings.SETTINGS_KEY_ALLOWLIST.includes("coreEndpoint"));
  assert.ok(settings.SETTINGS_KEY_ALLOWLIST.includes("interfaceDensity"));
  assert.equal(Object.isFrozen(settings.SETTINGS_KEY_ALLOWLIST), true);
});

test("assertValidSettingsKey accepts allow-listed keys and rejects unknowns (#129)", () => {
  for (const key of settings.SETTINGS_KEY_ALLOWLIST) {
    settings.assertValidSettingsKey(key);
  }
  assert.throws(() => settings.assertValidSettingsKey("rogue"), /unknown settings key/);
  assert.throws(() => settings.assertValidSettingsKey(undefined), /unknown settings key/);
  assert.throws(() => settings.assertValidSettingsKey(42), /unknown settings key/);
});

test("onboarding default state is unknown with empty completed set (#129)", () => {
  const s = onboarding.defaultOnboardingState();
  assert.equal(s.stage, onboarding.ONBOARDING_STAGES.UNKNOWN);
  assert.deepEqual(s.completed, []);
});

test("onboarding stages are canonical and frozen (#129)", () => {
  assert.equal(onboarding.ONBOARDING_STAGES.UNKNOWN, "unknown");
  assert.equal(onboarding.ONBOARDING_STAGES.DETECT_CORE, "detect-core");
  assert.equal(onboarding.ONBOARDING_STAGES.PAIR, "pair");
  assert.equal(onboarding.ONBOARDING_STAGES.SETTINGS, "settings");
  assert.equal(onboarding.ONBOARDING_STAGES.READY, "ready");
  assert.equal(Object.isFrozen(onboarding.ONBOARDING_STAGES), true);
});

test("advanceOnboarding walks the stage order and records completed (#129)", () => {
  const r1 = onboarding.advanceOnboarding(onboarding.defaultOnboardingState());
  assert.equal(r1.changed, true);
  assert.equal(r1.state.stage, onboarding.ONBOARDING_STAGES.DETECT_CORE);
  assert.deepEqual(r1.state.completed, [onboarding.ONBOARDING_STAGES.UNKNOWN]);

  const r2 = onboarding.advanceOnboarding(r1.state);
  assert.equal(r2.state.stage, onboarding.ONBOARDING_STAGES.PAIR);
  assert.deepEqual(r2.state.completed, [
    onboarding.ONBOARDING_STAGES.UNKNOWN,
    onboarding.ONBOARDING_STAGES.DETECT_CORE,
  ]);

  const r3 = onboarding.advanceOnboarding(r2.state);
  assert.equal(r3.state.stage, onboarding.ONBOARDING_STAGES.SETTINGS);
  const r4 = onboarding.advanceOnboarding(r3.state);
  assert.equal(r4.state.stage, onboarding.ONBOARDING_STAGES.READY);
  // advance past READY is a no-op
  const r5 = onboarding.advanceOnboarding(r4.state);
  assert.equal(r5.changed, false);
});

test("transitionOnboarding enforces the allowed graph (#129)", () => {
  const r1 = onboarding.transitionOnboarding(
    onboarding.defaultOnboardingState(),
    onboarding.ONBOARDING_STAGES.PAIR,
  );
  assert.equal(r1.state.stage, onboarding.ONBOARDING_STAGES.PAIR);
  assert.throws(
    () =>
      onboarding.transitionOnboarding(
        r1.state,
        onboarding.ONBOARDING_STAGES.UNKNOWN,
      ),
    /invalid onboarding transition/,
  );
  assert.throws(
    () =>
      onboarding.transitionOnboarding(
        onboarding.defaultOnboardingState(),
        "nonsense",
      ),
    /unknown onboarding stage/,
  );
});

test("loadOnboardingState cleans unknown stages (#129)", () => {
  const s = onboarding.loadOnboardingState({
    orchordsOnboardingState: { stage: "nonsense", completed: ["unknown", "nope"] },
  });
  assert.equal(s.stage, onboarding.ONBOARDING_STAGES.UNKNOWN);
  assert.deepEqual(s.completed, [onboarding.ONBOARDING_STAGES.UNKNOWN]);
});

test("persistOnboardingState writes to the canonical key (#129)", async () => {
  const storage = fakeStorage();
  const state = onboarding.defaultOnboardingState();
  await onboarding.persistOnboardingState(storage, state);
  assert.ok(storage._raw.onboarding_state_or_similar === undefined);
  assert.ok(storage._raw[onboarding.ONBOARDING_STORAGE_KEY]);
  assert.equal(
    storage._raw[onboarding.ONBOARDING_STORAGE_KEY].stage,
    onboarding.ONBOARDING_STAGES.UNKNOWN,
  );
});

test("onboarding reset returns to unknown with empty completed (#129)", () => {
  const r = onboarding.resetOnboarding();
  assert.equal(r.stage, onboarding.ONBOARDING_STAGES.UNKNOWN);
  assert.deepEqual(r.completed, []);
});

test("service-worker.js wires onboarding + settings + doctor (#129)", async () => {
  const sw = await readFile(path.join(repoRoot, "extension", "service-worker.js"), "utf8");
  assert.match(sw, /onboarding\.js/);
  assert.match(sw, /settings\.js/);
  assert.match(sw, /connection-doctor\.js/);
  // Storage keys may be imported as aliases (SETTINGS_STORAGE_KEY /
  // ONBOARDING_STORAGE_KEY) so accept either form.
  assert.match(
    sw,
    /SETTINGS_STORAGE_KEY|orchordsExtensionSettings/,
    "service-worker.js must reference the settings storage key",
  );
  assert.match(
    sw,
    /ONBOARDING_STORAGE_KEY|orchordsOnboardingState/,
    "service-worker.js must reference the onboarding storage key",
  );
  for (const action of [
    "reset_pairing",
    "set_settings",
    "run_doctor",
    "advance_onboarding",
    "transition_onboarding",
  ]) {
    assert.ok(sw.includes(action), `service-worker.js must handle user-action "${action}"`);
  }
});

test("popup.js wires onboarding + settings + doctor user actions (#129)", async () => {
  const popup = await readFile(path.join(repoRoot, "extension", "popup.js"), "utf8");
  // The popup is a thin renderer; it imports ONBOARDING_STAGES for its stage
  // list and emits typed user-action messages for the service worker to act on.
  assert.match(popup, /onboarding\.js/);
  assert.match(popup, /run_doctor/);
  assert.match(popup, /advance_onboarding/);
  assert.match(popup, /reset_onboarding/);
  assert.match(popup, /set_settings/);
  assert.match(popup, /reset_pairing/);
});
