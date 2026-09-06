# Extension Privileged-API Inventory

This is the canonical source-truth inventory for privileged Chrome/Edge API use in the Orchords Web Pilot MV3 extension. It is owned by #131 and is pinned by `test/extension-manifest.test.ts`, `test/extension-privileged-apis.test.ts`, `test/extension-security-boundary.test.ts`, and the #137 extension security matrix.

The shipped manifest currently requests exactly `activeTab`, `alarms`, `nativeMessaging`, and `storage`. It has no `host_permissions`, no `externally_connectable`, and no `web_accessible_resources`. Extension pages use `script-src 'self'; object-src 'self';`.

## Allow-list

### `chrome.runtime.connectNative(HOST_NAME)`

- **Allowed call site:** `extension/service-worker.js` only, inside `connectNativeBridge()`.
- The service worker owns the Native Messaging port lifecycle and passes the already-open port to `AuthenticatedBridgeClient`.
- `extension/bridge-client.js` **does not call** `connectNative`; it signs outbound authenticated envelopes, verifies authenticated host responses, handles cancellation, and operates on the injected port.
- Pairing/authentication ownership is #123. The host validates binding, generation, deadlines, authenticated envelopes, and replay state before dispatch.

### `chrome.runtime.sendNativeMessage(HOST_NAME, message)`

- Allowed call site: none today. Introduction requires an inventory update and a regression test.

### `chrome.runtime.onMessage`

- Allowed call sites: `extension/service-worker.js`, `extension/popup.js`, and the read-only `extension/content-script.js` bridge listener.
- The privileged service-worker listener rejects senders whose `sender.id !== chrome.runtime.id` before user-action dispatch. `test/extension-security-boundary.test.ts` executes that real listener with a foreign sender and proves that no control-state broadcast or native connection is triggered.

### `chrome.runtime.sendMessage`

- Allowed call sites: `extension/service-worker.js`, `extension/popup.js`, and the read-only content-script relay where present.
- Purpose: extension-internal control-state/user-action messaging only. The manifest exposes no `externally_connectable` surface.

### `chrome.storage.local`

- Allowed call sites: `extension/pairing-state.js` and `extension/service-worker.js`.
- Purpose: pairing state, site authorization state, settings/onboarding state, migration state, and bounded extension-owned metadata.
- Raw page DOM/content and arbitrary host filesystem paths are not permitted persistence payloads.

### `chrome.storage.session`

- Allowed call site: `extension/service-worker.js`.
- Purpose: bounded session-only state such as replay/control/support-bundle state that must not become persistent site data.

### `chrome.alarms`

- Allowed call site: `extension/service-worker-lifecycle.js` via its injected Chrome adapter.
- Purpose: MV3 wake/reconnect heartbeat only.
- Manifest permission: `alarms`.

### `chrome.action`

- Allowed call site: `extension/service-worker.js`; the manifest also binds `extension/popup.html` as `action.default_popup`.
- Purpose: visible control state and badge/status UI. Popup code must not inject host-page script.

### `chrome.tabs` read-only lifecycle adapters

- `extension/tab-attachment.js` may bind/read `chrome.tabs`-shaped adapters for deterministic tab identity/lifecycle when the corresponding provider supplies them.
- Destructive or script-injection APIs such as `chrome.tabs.executeScript`, `chrome.tabs.update`, and `chrome.tabs.remove` are forbidden by current policy.
- The shipped manifest does **not** request the broad `tabs` permission.

## Forbidden list

The following APIs or permission families are not part of the shipped extension authority. Adding any of them requires a new security review, manifest justification, source-policy update, and executable regression coverage.

| Forbidden API/family | Permission withheld | Owner/regression |
| --- | --- | --- |
| `chrome.debugger.attach` / `detach` / `sendCommand` | `debugger` | #131 manifest/source scan |
| `chrome.scripting.executeScript` / `insertCSS` / `removeCSS` / `registerContentScripts` | `scripting` | #131 manifest/source scan |
| `chrome.tabs.executeScript` | broad tab/script authority | #131 source scan |
| `chrome.webRequest.*` | `webRequest` | #131 manifest/source scan |
| `chrome.proxy.*` | `proxy` | #131 manifest/source scan |
| `chrome.cookies.*` | `cookies` | #131 manifest/source scan |
| `chrome.history.*` | `history` | #131 manifest/source scan |
| `chrome.bookmarks.*` | `bookmarks` | #131 source scan |
| `chrome.browsingData.*` | `browsingData` | #131 manifest/source scan |
| `chrome.contentSettings.*` | `contentSettings` | #131 manifest/source scan |
| `chrome.management.*` | `management` | #131 manifest/source scan |
| `chrome.privacy.*` | `privacy` | #131 manifest/source scan |
| `chrome.pageCapture.*` | `pageCapture` | #131 manifest/source scan |
| `chrome.tabCapture.*` / `chrome.desktopCapture.*` | capture permissions | #131 source scan |
| `chrome.identity.*` | `identity` | #131 manifest/source scan |
| `chrome.gcm.*` / push messaging | `gcm` / notifications | #131 manifest/source scan |
| `chrome.downloads.*` | `downloads` | #131 manifest/source scan |
| `chrome.enterprise.platformKeys.*` / `chrome.platformKeys.*` | not requested | #131 source scan |
| broad host patterns such as `<all_urls>`, `http://*/*`, `https://*/*`, `*://*/*`, `file://*/*` | no host permissions | #131 manifest test |
| `externally_connectable` page/extension entry points | not configured | #131 manifest/security-boundary tests |

## Inventory by file

- `extension/manifest.json`: declarative MV3 configuration only; exact permissions/CSP are release-gated.
- `extension/service-worker.js`: privileged runtime owner. Directly owns `chrome.runtime.connectNative`, `chrome.runtime.onMessage`, install/startup/action listeners, extension-internal `runtime.sendMessage`, `chrome.storage.local`, `chrome.storage.session`, and action badge state. It delegates cryptographic/authentication behavior to pure modules.
- `extension/bridge-client.js`: no privileged API creation; consumes an already-open Native Messaging-shaped port and implements authenticated request/cancel/response behavior.
- `extension/bridge-protocol.js`: pure protocol encoding/validation.
- `extension/bridge-auth.js`: pure authentication computation/verification.
- `extension/pairing-state.js`: `chrome.storage.local` pairing-state persistence/validation only.
- `extension/control-state.js`: pure control-state machine and approval invalidation.
- `extension/site-authorizations.js`: pure per-origin grant/deny registry; persistence is owned by the service worker. Owner #124.
- `extension/settings.js`: pure settings validation; persistence owned by service worker. Owner #129.
- `extension/onboarding.js`: pure onboarding state machine; persistence owned by service worker. Owner #129.
- `extension/connection-doctor.js`: pure redacted diagnostics. Owner #129.
- `extension/popup.html`: declarative extension page under extension-page CSP.
- `extension/popup.js`: extension-internal `chrome.runtime.sendMessage` / `onMessage` UI messaging only.
- `extension/popup.css`: bundled extension stylesheet; no privileged API.
- `extension/tab-attachment.js`: deterministic tab identity/lifecycle logic; optional read-only `chrome.tabs`-shaped adapter. Owner #126.
- `extension/bridge-relay.js`: pure connected-port relay; no privileged browser authority. Owner #127.
- `extension/content-script.js`: read-only page-observation/relay boundary; no script-injection, debugger, cookie, history, or network-interception authority. Owner #127.
- `extension/cdp-adapter.js`: pure policy/redaction adapter; does not itself call `chrome.debugger`. Owner #132.
- `extension/side-panel.html`, `extension/side-panel.js`, `extension/side-panel.css`: extension-page inspector. Renderer uses inert text output for untrusted values; `test/extension-security-boundary.test.ts` executes hostile-origin rendering. Owner #128.
- `extension/service-worker-lifecycle.js`: MV3 lifecycle/reconnect logic; may use injected `chrome.alarms` adapter. Owner #130.
- `extension/envelope-cancellation.js`: pure cancellation/version negotiation. Owner #133.
- `extension/browser-attach.js`: pure authenticated browser-reuse metadata/policy adapter; no cookie export. Owner #134.
- `extension/schema-migrations.js`: pure persisted-state migration/rollback. Owner #138.
- `extension/artifact-transfer.js`: pure artifact-reference/chunk policy; rejects path leakage/traversal. Owner #140.
- `extension/support-bundle.js`: pure redacted support-bundle generator. Owner #141.

## Trust-boundary invariants

1. Page-derived data is untrusted input. It cannot grant itself site authority, open Native Messaging, or bypass the service-worker sender/policy gates.
2. Pairing credentials and host authentication material must never be inserted into page DOM, content-script page messages, screenshots, or support bundles.
3. UI renders untrusted origins/labels as text, not executable markup. The extension CSP forbids remote/eval code.
4. Site authorization is a necessary extension-side gate, not sufficient authority to bypass canonical core policy (#45/#80/#81/#112).
5. Any new privileged API, permission, host pattern, externally-connectable surface, or additional allowed call site is a release-gate change.

## Update rule

Any privileged-surface change must update this document and a regression test in the same implementation sequence, then pass lint, build, the full test suite, minimum-Playwright/package validation, and CodeQL before the issue is considered satisfied.

## Owners

- #131 — extension manifest, privileged APIs, CSP and extension threat boundary.
- #123 — authenticated extension↔native-host bridge.
- #124 — per-site/per-origin authorization and consent lifetime.
- #125 — visible control state/takeover UI.
- #126 — deterministic tab attachment.
- #127 — content-script/relay isolation.
- #128 — side-panel inspector.
- #129 — onboarding/settings/reset/doctor.
- #130 — MV3 lifecycle/reconnect.
- #132 — CDP policy adapter.
- #133 — envelope cancellation/version compatibility.
- #134 — browser reuse/attachment boundary.
- #137 — real-browser extension regression matrix.
- #138 — update/schema migration/rollback.
- #139 — incognito/multi-profile/enterprise policy.
- #140 — artifact transfer.
- #141 — diagnostics/support bundle.
- #91 — cross-product threat model/release assurance.
