import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Canonical extension-security regression matrix (#137).
// Each entry is a file that MUST remain on disk and MUST contain at least one
// assertion keyword that would fail if the corresponding guarantee were deleted.
// Silent deletion of any of these files (or of the assertion that pins the
// guarantee) is a release-gate violation.
type MatrixEntry = {
  relPath: string;
  keywords: ReadonlyArray<string>;
};

const matrix: ReadonlyArray<MatrixEntry> = [
  {
    relPath: "test/extension-manifest.test.ts",
    keywords: ["manifest_version", "nativeMessaging", "unsafe-eval", "debugger"],
  },
  {
    relPath: "test/extension-privileged-apis.test.ts",
    keywords: ["chrome.debugger", "chrome.scripting", "chrome.webRequest", "#131"],
  },
  {
    relPath: "test/extension-bridge-auth.test.ts",
    keywords: ["assert"],
  },
  {
    relPath: "test/extension-bridge-client.test.ts",
    keywords: ["assert"],
  },
  {
    relPath: "test/extension-bridge-protocol.test.ts",
    keywords: ["assert"],
  },
  {
    relPath: "test/extension-bridge-version-handshake.test.ts",
    keywords: [
      "bridge.hello payload freezes protocol + version range",
      "bridge.welcome payload freezes protocol + core version",
      "evaluateCompatibility rejects a core version below the floor",
      "compat.report envelope payload is well-formed",
    ],
  },
  {
    relPath: "test/extension-bridge-backpressure.test.ts",
    keywords: [
      "BridgeOutboundQueue enforces its bounded capacity",
      "BridgeOutboundQueue rejects non-objects",
      "BridgeOutboundQueue drains in FIFO order",
      "BridgeOutboundQueue drops expired envelopes and reports the count",
    ],
  },
  {
    relPath: "test/extension-tab-attachment.test.ts",
    keywords: [
      "canonicalTabUrl lowercases host and drops default port",
      "attach by tabId resolves and records a monotonic token",
      "attach by urlPrefix prefers the active tab",
      "attachments older than maxAgeMs are swept on resolve",
    ],
  },
  {
    relPath: "test/extension-content-script.test.ts",
    keywords: [
      "BridgeRelay hello envelope is well-formed",
      "BridgeRelay publishes events over the connected port",
      "BridgeRelay.sendToPage resolves with the matched response",
      "BridgeRelay.sendToPage rejects on disconnect",
    ],
  },
  {
    relPath: "test/extension-cdp-adapter.test.ts",
    keywords: [
      "CDP adapter allow-list is exported and frozen",
      "CDP adapter rejects methods outside the allow-list",
      "CDP adapter redacts header secrets in Network.enable",
      "CDP adapter redacts cookie values in Network.getCookies",
      "CDP adapter redacts Runtime.evaluate expressions",
    ],
  },
  {
    relPath: "test/extension-side-panel.test.ts",
    keywords: [
      "renderSidePanel writes a heading + audit + registry + doctor",
      "renderSidePanel escapes untrusted origin values",
      "renderSidePanel defaults to disconnected when snapshot is missing",
    ],
  },
  {
    relPath: "test/extension-service-worker-lifecycle.test.ts",
    keywords: [
      "SWLifecycle heartbeat is scheduled on start",
      "SWLifecycle.triggerReconnect runs the backoff schedule",
      "SWLifecycle.resumeInflight drops expired envelopes and re-posts live ones",
      "SWLifecycle.trackOutbound rejects duplicates",
    ],
  },
  {
    relPath: "test/extension-native-bridge.test.ts",
    keywords: ["assert"],
  },
  {
    relPath: "test/extension-pairing-state.test.ts",
    keywords: ["assert"],
  },
  {
    relPath: "test/extension-provider-contract.test.ts",
    keywords: ["assert"],
  },
  {
    relPath: "test/extension-control-state.test.ts",
    keywords: [
      "control-state enumerates the seven states",
      "takeover invalidates every stale approval",
      "popup.html, popup.js and popup.css exist and contain the user-action surface",
      "service-worker routes user-action messages through control-state",
    ],
  },
  {
    relPath: "test/extension-site-authorizations.test.ts",
    keywords: [
      "canonical origin",
      "ONCE grant is consumed by the first dispatch",
      "storage key is exported",
      "popup.js wires site authorization",
      "service-worker.js persists and consults the site-authorization registry",
    ],
  },
  {
    relPath: "test/extension-connection-doctor.test.ts",
    keywords: [
      "happy path returns ok severity",
      "doctor never returns raw secrets",
      "doctor exports its functions",
    ],
  },
  {
    relPath: "test/extension-settings.test.ts",
    keywords: [
      "unknown keys are dropped on clean",
      "settings key allow-list is exported and frozen",
      "onboarding stages are canonical and frozen",
      "transitionOnboarding enforces the allowed graph",
      "service-worker.js wires onboarding + settings + doctor",
      "popup.js wires onboarding + settings + doctor user actions",
    ],
  },
  {
    relPath: "test/native-host-authenticated.test.ts",
    keywords: ["assert"],
  },
  {
    relPath: "test/native-host-pairing.test.ts",
    keywords: ["assert"],
  },
  {
    relPath: "test/native-messaging.test.ts",
    keywords: ["assert"],
  },
  {
    relPath: "test/threat-model.test.ts",
    keywords: ["EXT-NM-LOCAL-001", "MUST NOT claim resistance"],
  },
  {
    relPath: "test/extension-threat-model.test.ts",
    keywords: [
      "extension threat model document exists and is owned by #131",
      "extension threat model enumerates every in-scope extension file",
      "every extension file referenced by the threat model exists on disk",
      "extension threat model references its companion issue owners",
    ],
  },
  {
    relPath: "docs/security/threat-model.md",
    keywords: ["EXT-NM-LOCAL-001", "#131 owns extension manifest/permission security", "#137 owns extension security regression coverage"],
  },
  {
    relPath: "docs/security/extension-threat-model.md",
    keywords: [
      "owned by",
      "#131",
      "STRIDE per extension file",
      "manifest.json",
      "service-worker.js",
      "bridge-protocol.js",
      "bridge-auth.js",
      "bridge-client.js",
      "pairing-state.js",
      "control-state.js",
      "site-authorizations.js",
      "settings.js",
      "onboarding.js",
      "connection-doctor.js",
      "popup.html",
      "popup.js",
    ],
  },
  {
    relPath: "docs/security/extension-privileged-apis.md",
    keywords: [
      "Forbidden list",
      "bridge-client.js",
      "service-worker.js",
      "pairing-state.js",
      "bridge-protocol.js",
      "bridge-auth.js",
      "control-state.js",
      "site-authorizations.js",
      "settings.js",
      "onboarding.js",
      "connection-doctor.js",
      "popup.html",
      "popup.js",
      "popup.css",
    ],
  },
];

test("extension security regression matrix is present and pinned (#137)", async () => {
  for (const entry of matrix) {
    const fullPath = path.join(repoRoot, ...entry.relPath.split("/"));
    await access(fullPath);
    const text = await readFile(fullPath, "utf8");
    for (const keyword of entry.keywords) {
      assert.ok(
        text.includes(keyword),
        `${entry.relPath} must pin keyword ${JSON.stringify(keyword)} so silent deletion of the guarantee is caught`,
      );
    }
  }
});

test("privileged-API inventory enumerates every in-scope extension file (#137)", async () => {
  const inventory = await readFile(
    path.join(repoRoot, "docs", "security", "extension-privileged-apis.md"),
    "utf8",
  );
  for (const file of [
    "bridge-client.js",
    "bridge-protocol.js",
    "bridge-auth.js",
    "pairing-state.js",
    "control-state.js",
    "service-worker.js",
    "tab-attachment.js",
    "bridge-relay.js",
    "content-script.js",
    "cdp-adapter.js",
    "side-panel.js",
    "side-panel.html",
    "side-panel.css",
    "service-worker-lifecycle.js",
    "manifest.json",
    "popup.html",
    "popup.js",
    "popup.css",
  ]) {
    assert.ok(
      inventory.includes(file),
      `privileged-API inventory must enumerate ${file}`,
    );
  }
  assert.match(inventory, /## Forbidden list/);
  assert.match(inventory, /## Allow-list/);
  assert.match(inventory, /## Inventory by file/);
});

test("extension security tests do not positively exercise forbidden privileged APIs (#137)", async () => {
  // A test that asserts chrome.debugger IS used (as opposed to asserting it is
  // withheld) would silently invert the policy. We scan the extension-*.test.ts
  // files for positive-use patterns of the most dangerous APIs.
  //
  // We exclude `extension-privileged-apis.test.ts` because that test is itself
  // the policy-bearing source of the forbidden-token list; it necessarily cites
  // the same tokens it is supposed to forbid (mirrors the exclusion of the
  // inventory doc in `test/extension-privileged-apis.test.ts`).
  const testDir = path.join(repoRoot, "test");
  const { readdir } = await import("node:fs/promises");
  const names = await readdir(testDir);
  const extensionTests = names.filter(
    (name) =>
      name.startsWith("extension-") &&
      name.endsWith(".test.ts") &&
      name !== "extension-privileged-apis.test.ts",
  );
  assert.ok(
    extensionTests.length >= 8,
    "expected the full extension-*.test.ts set to remain on disk",
  );

  const positiveUse = [
    /chrome\.debugger\.(attach|detach|sendCommand)/,
    /chrome\.scripting\.(executeScript|insertCSS|registerContentScripts)/,
    /chrome\.tabs\.executeScript/,
    /chrome\.webRequest\.on/,
  ];

  for (const name of extensionTests) {
    const text = await readFile(path.join(testDir, name), "utf8");
    for (const pattern of positiveUse) {
      assert.equal(
        pattern.test(text),
        false,
        `test/${name} must not positively exercise ${pattern}`,
      );
    }
  }
});
