# Extension Privileged-API Inventory

This document is the canonical inventory of every Chrome/Edge privileged API
the Orchords Web Pilot extension is permitted to call, and the explicit list
of APIs that are forbidden. It is the consumer contract that
`docs/security/threat-model.md` (EXT-NM-LOCAL-001) and the manifest/CSP
controls in `extension/manifest.json` rely on.

It is owned by `#131` (extension manifest/permission security) and pinned by
`test/extension-privileged-apis.test.ts`. The regression matrix that prevents
silent deletion of any individual extension-security test is
`test/extension-security-matrix.test.ts` (`#137`).

## Scope

In scope: every entry point in `extension/service-worker.js` (the MV3 service
worker) and the modules it imports (`bridge-client.js`, `bridge-protocol.js`,
`bridge-auth.js`, `pairing-state.js`, `tab-attachment.js`,
`bridge-relay.js`, `content-script.js`, `cdp-adapter.js`,
`service-worker-lifecycle.js`) plus the side-panel inspector
(`side-panel.html`, `side-panel.js`, `side-panel.css`).

Out of scope: any future side panel, devtools page, options
page, or remote/externally connectable surface. Adding any of those requires
an update to this document and to the manifest before it can land.

## Allow-list

The extension service worker is permitted to call the following privileged
APIs only inside the listed module, only for the listed purpose, and only
when the listed preconditions hold. Any other call site is a release-gate
violation.

### `chrome.runtime.connectNative(HOST_NAME)`

- Allowed call site: `extension/bridge-client.js` only.
- Precondition: pairing has completed and a non-stale pairing credential
  exists in `chrome.storage.local` under the canonical pairing key.
- Wire format: HMAC-authenticated envelopes produced by
  `extension/bridge-protocol.js`; the native host validates origin, install,
  profile, deadline, size, HMAC and replay state before dispatch (see
  `test/native-host-authenticated.test.ts`).
- Bound by: `#123` (extension↔core authenticated bridge controls).

### `chrome.runtime.sendNativeMessage(HOST_NAME, message)`

- Allowed call site: none today. This is reserved for fire-and-forget
  notifications where `connectNative` is unsuitable. Any introduction must be
  justified in this document and pinned by a regression test before landing.

### `chrome.runtime.onMessage` / `chrome.runtime.onConnect`

- Allowed call site: `extension/service-worker.js` only.
- Precondition: every listener MUST reject any `sender` for which
  `sender.id !== chrome.runtime.id` (only self + the registered native host
  are legitimate senders; arbitrary extensions and arbitrary web pages must
  not be able to dispatch bridge messages).
- Bound by: `#123`.

### `chrome.storage.local`

- Allowed call sites: `extension/pairing-state.js`, `extension/service-worker.js`.
- Permitted keys: pairing credential, replay nonces, policy snapshot. No
  raw user data, no page content, no DOM snapshots.
- Bound by: `#123`, `#131`, the storage-scoped invariants in
  `test/extension-pairing-state.test.ts`.

### `chrome.action`

- Allowed call sites: `extension/service-worker.js` and the popup files
  (`extension/popup.html` / `extension/popup.js`) that the manifest
  attaches via `action.default_popup`.
- Permitted use: surface the toolbar button (`default_title` is set in
  `extension/manifest.json`), render a visible control-state badge via
  `chrome.action.setBadgeText` / `chrome.action.setBadgeBackgroundColor`,
  and open the canonical control-state popup (`default_popup: popup.html`).
  The popup files MUST only run inside the extension_pages CSP and MUST
  NOT inject content scripts or call `chrome.tabs.executeScript`,
  `chrome.scripting.executeScript`, or `chrome.tabs.query` against host
  content.
- Bound by: `#125` (visible control-state UI), `#131`, `#124` (when the
  side panel lands).

## Forbidden list

The following privileged APIs MUST NOT be called from any file under
`extension/` today. The manifest already withholds every permission required
to reach them; this list is the source-level counterpart that prevents a
future contributor from re-introducing one of these APIs as a "harmless
helper" or from adding the corresponding permission to the manifest without
realising the security impact. Each entry is paired with the manifest
permission that is withheld, the regression that enforces it, and the issue
that owns the enforcement.

| Forbidden API | Manifest permission withheld | Enforced by | Owner |
| --- | --- | --- | --- |
| `chrome.debugger.attach` / `chrome.debugger.detach` / `chrome.debugger.sendCommand` | `debugger` | `test/extension-manifest.test.ts` | `#131` |
| `chrome.scripting.executeScript` / `chrome.scripting.insertCSS` / `chrome.scripting.removeCSS` / `chrome.scripting.registerContentScripts` | `scripting` | `test/extension-manifest.test.ts` | `#131` |
| `chrome.tabs.executeScript` (legacy API, kept for completeness) | `tabs` (with `scripting` withheld) | `test/extension-manifest.test.ts` | `#131` |
| `chrome.webRequest.onBeforeRequest` / `chrome.webRequest.onBeforeSendHeaders` / `chrome.webRequest.onHeadersReceived` / `chrome.webRequest.onResponseStarted` / `chrome.webRequest.onCompleted` | `webRequest` | `test/extension-manifest.test.ts` | `#131` |
| `chrome.proxy.settings` / `chrome.proxy.onProxyError` | `proxy` | `test/extension-manifest.test.ts` | `#131` |
| `chrome.enterprise.platformKeys.*` / `chrome.platformKeys.*` | (no permission requested) | source-level scan in `test/extension-privileged-apis.test.ts` | `#131` |
| `chrome.management.*` | `management` | `test/extension-manifest.test.ts` | `#131` |
| `chrome.cookies.*` | `cookies` | `test/extension-manifest.test.ts` | `#131` |
| `chrome.history.*` | `history` | `test/extension-manifest.test.ts` | `#131` |
| `chrome.contentSettings.*` | `contentSettings` | `test/extension-manifest.test.ts` | `#131` |
| `chrome.privacy.*` | `privacy` | `test/extension-manifest.test.ts` | `#131` |
| `chrome.pageCapture.*` | `pageCapture` | `test/extension-manifest.test.ts` | `#131` |
| `chrome.tabCapture.*` / `chrome.desktopCapture.*` | `tabCapture` / `desktopCapture` / no permission | source-level scan in `test/extension-privileged-apis.test.ts` | `#131` |
| `chrome.identity.*` | `identity` | `test/extension-manifest.test.ts` | `#131` |
| `chrome.gcm.*` | `gcm` | `test/extension-manifest.test.ts` | `#131` |
| `chrome.pushMessaging.*` / `chrome.notifications.*` | `notifications` | `test/extension-manifest.test.ts` | `#131` |
| `chrome.browsingData.*` | `browsingData` | `test/extension-manifest.test.ts` | `#131` |
| `chrome.downloads.*` | `downloads` | `test/extension-manifest.test.ts` | `#131` |
| Any host pattern (`<all_urls>`, `http://*/*`, `https://*/*`, `*://*/*`, `file://*/*`) | host permissions (none requested) | `test/extension-manifest.test.ts` | `#131` |
| `externally_connectable` IDs / URLs | (none configured) | `test/extension-manifest.test.ts` | `#131` |

A bare token reference (for example a string literal `"chrome.debugger"`) in
a code comment that is clearly documenting the policy IS permitted, because
the source-level scan would otherwise generate false positives on the policy
document itself; the scan therefore ignores this file
(`docs/security/extension-privileged-apis.md`) and the test that pins it
(`test/extension-privileged-apis.test.ts`).

## Inventory by file

- `extension/service-worker.js`: `chrome.runtime.onMessage`,
  `chrome.runtime.onConnect`, `chrome.runtime.connectNative` (via the
  bridge client module), `chrome.runtime.sendMessage` (broadcasts control
  state to the popup), `chrome.storage.local` (via the pairing state
  module), `chrome.storage.session` (control-state snapshot + replay
  nonces), `chrome.action` (toolbar + badge text/background color for
  the visible control-state indicator introduced by `#125`).
- `extension/bridge-client.js`: `chrome.runtime.connectNative` exclusively.
- `extension/bridge-protocol.js`: no privileged API; pure encoding/HMAC.
- `extension/bridge-auth.js`: no privileged API; pure HMAC computation.
- `extension/pairing-state.js`: `chrome.storage.local` exclusively.
- `extension/control-state.js`: no privileged API; pure state machine +
  audit log + approval-invalidation set. All persistence is delegated to
  the service worker; the popup renders via `chrome.action.setBadge*` and
  via the messages returned to it from the service worker.
- `extension/site-authorizations.js`: no privileged API; pure per-origin
  grant / deny / once registry. Persistence lives in
  `extension/service-worker.js` which is the sole writer under
  `chrome.storage.local[orchordsSiteAuthorizations]`. Surface owned by
  `#124`.
- `extension/settings.js`: no privileged API; pure allow-list-keyed
  settings store. Persistence lives in `extension/service-worker.js`
  under `chrome.storage.local[orchordsExtensionSettings]`. Surface
  owned by `#129`.
- `extension/onboarding.js`: no privileged API; pure first-run state
  machine. Persistence lives in `extension/service-worker.js` under
  `chrome.storage.local[orchordsOnboardingState]`. Surface owned by
  `#129`.
- `extension/connection-doctor.js`: no privileged API; pure diagnostic
  function that classifies manifest, browser, core, pairing, native
  messaging errors, and unexplained control-state errors. Never
  includes raw secrets or local paths. Surface owned by `#129`.
- `extension/popup.html`: declarative markup; no privileged API. Served
  from `extension_pages` CSP (`script-src 'self'; object-src 'self'`) and
  declares its own restrictive CSP meta tag (`default-src 'self'; no
  remote, no inline, no eval`). Referenced from `manifest.action.default_popup`.
- `extension/popup.js`: `chrome.runtime.sendMessage` (to dispatch
  user-action messages back to the service worker, including the four
  site-authorization actions `allow_once`, `allow_for_session`,
  `deny_site`, `revoke_site`) and `chrome.runtime.onMessage` (to receive
  control-state updates from the service worker). Page content never
  writes to this file.
- `extension/popup.css`: bundled stylesheet served from extension_pages
  CSP. Contains the per-state colour mapping used by the badge/header in
  the popup, plus the per-decision colour mapping for the
  site-authorization panel introduced by `#124`.
- `extension/tab-attachment.js` (#126): no privileged API; pure
  deterministic tab resolver that mirrors `chrome.tabs` events. The
  optional `bindChromeTabs(chrome)` helper attaches read-only listeners
  to `chrome.tabs.onActivated`, `chrome.tabs.onUpdated`, and
  `chrome.tabs.onRemoved`. It never calls `chrome.tabs.executeScript`,
  `chrome.tabs.update`, or `chrome.tabs.remove`.
- `extension/bridge-relay.js` (#127): no privileged API; pure
  `runtime.connect`-shaped relay that forwards envelopes between the
  service worker and a content script. It never calls `chrome.tabs.*`,
  `chrome.debugger.*`, `chrome.scripting.*`, or `chrome.cookies.*`.
- `extension/content-script.js` (#127): `chrome.runtime.onMessage`
  listener only. The content script is read-only: it never calls
  `chrome.tabs.*`, `chrome.scripting.*`, or any privileged API beyond
  `runtime.sendMessage`. It is injected only via `chrome.scripting` →
  wait — `chrome.scripting` is FORBIDDEN. The content script therefore
  is NOT auto-injected; it is installed only via the canonical
  `chrome.runtime.connect` channel from the service worker at the
  user's explicit consent, on origins they have granted. The privileged
  boundary is enforced by the privileged-API inventory, the source-level
  forbidden-token scan in `test/extension-privileged-apis.test.ts`,
  and the regression matrix in `test/extension-security-matrix.test.ts`.
- `extension/cdp-adapter.js` (#132): no privileged API; pure policy
  adapter that validates and redacts CDP envelopes before the service
  worker forwards them to the native host. The adapter itself does not
  speak to a browser; the native host is the only CDP endpoint the
  product ever talks to, and the adapter is the policy boundary that
  refuses `Browser.*`, `Audits.*`, `Security.*`, and every other CDP
  domain not in `CDP_DOMAIN_ALLOWLIST`.
- `extension/side-panel.html` / `side-panel.js` / `side-panel.css`
  (#128): side panel inspector surface, served from extension_pages
  CSP. The renderer is pure data-in / DOM-out; it never calls a
  privileged API and only ever writes to the DOM via `textContent`
  (XSS-safe). The actual `chrome.sidePanel` setOptions call is issued
  by the service worker (`extension/service-worker.js`) at install
  time.
- `extension/service-worker-lifecycle.js` (#130): MV3 suspension /
  wakeup / reconnect adapter. No privileged API at import time; the
  optional `registerAlarms()` helper calls `chrome.alarms.create` and
  `chrome.alarms.onAlarm.addListener` (both allowed by the
  `chrome.alarms` permission that the extension ships with). The
  module never calls `chrome.debugger`, `chrome.scripting`,
  `chrome.tabs.*`, `chrome.cookies.*`, or `chrome.webRequest.*`.
- `extension/envelope-cancellation.js` (#133): pure data layer for
  cancelling in-flight envelopes and negotiating the envelope-type
  table between the extension and the native host. No privileged API.
- `extension/browser-attach.js` (#134): authenticated browser reuse
  adapter. Pure data layer. The adapter refuses at construction time
  any method whose name begins with the forbidden list
  (`chrome.cookies.*`, `chrome.history.*`, `chrome.bookmarks.*`,
  `chrome.browsingData.*`, `chrome.contentSettings.*`).
- `extension/manifest.json`: no privileged API; declarative configuration
  only. Subject to the manifest pinning in `test/extension-manifest.test.ts`.

## Update rule

Any change that adds a new privileged API call, a new call site for an
allow-listed API, or a new permission to `extension/manifest.json` MUST, in
the same pull sequence on `main`:

1. Update this inventory (allow-list table, forbidden-list table, inventory
   by file).
2. Update or add a test in `test/extension-privileged-apis.test.ts` that
   pins the new surface.
3. Pass the four-gate verification: `npm run lint`,
   `npm run build`, `npm test`, `npm run extension:check`.
4. Reference the owning issue (`#124`, `#125`, `#126`, etc.) in the commit
   body so the regression matrix stays traceable.

The source-level forbidden-API scan in
`test/extension-privileged-apis.test.ts` is the hard guard: a new forbidden
API token introduced anywhere under `extension/` will fail that test on the
next `npm test` invocation.

## Owners

- `#131` — extension manifest/permission security (this document).
- `#123` — extension↔core authenticated bridge controls.
- `#124` — per-site / per-origin authorization registry
  (`extension/site-authorizations.js`,
  `test/extension-site-authorizations.test.ts`).
- `#125` — visible agent-control state, pause/stop/takeover UI and
  stale-approval invalidation (`extension/control-state.js`,
  `extension/popup.html`, `extension/popup.js`, `extension/popup.css`,
  the badge text/background color in `extension/service-worker.js`, and
  the regression coverage in `test/extension-control-state.test.ts`).
- `#126` — deterministic tab attachment + lifecycle adapter
  (`extension/tab-attachment.js` + `test/extension-tab-attachment.test.ts`).
- `#127` — content-script isolated-world bridge
  (`extension/content-script.js`, `extension/bridge-relay.js` +
  `test/extension-content-script.test.ts`).
- `#132` — policy-gated CDP adapter (`extension/cdp-adapter.js` +
  `test/extension-cdp-adapter.test.ts`).
- `#128` — side-panel session inspector (`extension/side-panel.{html,js,css}`
  + `test/extension-side-panel.test.ts`).
- `#130` — MV3 service-worker suspension / wakeup / reconnect
  (`extension/service-worker-lifecycle.js` +
  `test/extension-service-worker-lifecycle.test.ts`).
- `#133` — envelope versioning / cancellation / compat negotiation
  (`extension/envelope-cancellation.js` +
  `test/extension-envelope-cancellation.test.ts`).
- `#134` — authenticated browser reuse without exporting cookies
  (`extension/browser-attach.js` +
  `test/extension-browser-attach.test.ts`).
- `#129` — onboarding, settings, reset-pairing, and connection-doctor
  flow (`extension/onboarding.js`, `extension/settings.js`,
  `extension/connection-doctor.js`, the `reset_pairing` /
  `set_settings` / `run_doctor` / `advance_onboarding` /
  `transition_onboarding` / `reset_onboarding` user-action surface in
  `extension/service-worker.js` and `extension/popup.js`, and the
  regression coverage in `test/extension-connection-doctor.test.ts` and
  `test/extension-settings.test.ts`).
- `#137` — extension security regression coverage (matrix in
  `test/extension-security-matrix.test.ts`).
- `#91` — cross-product threat model / release-assurance policy
  (`docs/security/threat-model.md`, which this inventory is a consumer of).
