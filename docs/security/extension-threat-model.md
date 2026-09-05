# Extension Threat Model

This document is the file-level extension security record. It complements
`docs/security/threat-model.md` (which captures the cross-boundary trust
assumptions) by enumerating the threats specific to the
`extension/` source tree and the controls that address them. It is
**owned by `#131`** (extension manifest/permission security) and is
**pinned by `test/extension-threat-model.test.ts`**.

The matrix test verifies that every threat row in this document has a
matching source-level control in the corresponding extension file. Silent
deletion of either a threat row or the corresponding control is caught
by the regression matrix in `test/extension-security-matrix.test.ts`.

## Trust boundary

The extension runs in a Manifest V3 sandbox (`extension_pages`) with the
permission set `["activeTab", "nativeMessaging", "storage"]`. It can
*only*:

- read/write its own extension storage (`chrome.storage.local`,
  `chrome.storage.session`),
- open a *single* native-messaging port to the local companion
  `com.orchords.web_pilot` host,
- request one-time tab access for the active tab when the user clicks the
  toolbar icon (`activeTab`).

It **cannot**:

- read cookies, history, or bookmarks (`chrome.cookies`,
  `chrome.history`, `chrome.bookmarks` are forbidden),
- attach the Chrome DevTools Protocol (`chrome.debugger` is forbidden),
- inject scripts into web pages (`chrome.scripting`,
  `chrome.tabs.executeScript` are forbidden),
- intercept network traffic (`chrome.webRequest`, `chrome.proxy` are
  forbidden),
- declare a public externally-connectable surface
  (`externally_connectable` is omitted, so only the extension itself
  can `runtime.sendMessage` the service worker),
- host a remote origin in its CSP (`script-src 'self'; object-src 'self'`
  is the manifest CSP; the popup meta CSP is `default-src 'self'` and
  forbids remote origins, inline scripts, `unsafe-eval`, and `unsafe-inline`).

## STRIDE per extension file

| File | Threat (STRIDE) | Control in file |
| ---- | --------------- | --------------- |
| `manifest.json` | T — declare a privileged permission not in the inventory | Permission array is the frozen literal `["activeTab", "nativeMessaging", "storage"]`; manifest test forbids `debugger`, `scripting`, `tabs`, `webRequest`, `<all_urls>` |
| `manifest.json` | T — load remote code via CSP | `extension_pages` CSP is the literal `script-src 'self'; object-src 'self';`; no `'unsafe-eval'`, no `'unsafe-inline'`, no remote scheme |
| `service-worker.js` | E — escalate by talking to a non-allow-listed native host | `connectNativeBridge()` is hard-coded to `com.orchords.web_pilot`; no caller can substitute a host name |
| `service-worker.js` | R — deny user-initiated `disconnect`/`stop` | `service-worker.js` calls `applyControlTransition()` for every `user-action` message and persists the audit |
| `service-worker.js` | I — accept messages from non-extension senders | `isTrustedSender()` requires `sender.id === chrome.runtime.id`; untrusted senders are rejected with a log |
| `service-worker.js` | I — accept unknown `action` values | `USER_ACTIONS` set is the canonical allow-list; unknown actions are logged and dropped |
| `bridge-protocol.js` | T — replay an old envelope | `validateBridgeEnvelope()` consults the `ReplayWindow`; replayed envelopes are rejected with `code: "replay"` |
| `bridge-protocol.js` | T — bypass the bridge protocol version | `validateBridgeEnvelope()` enforces `message.protocol === BRIDGE_PROTOCOL_VERSION` |
| `bridge-protocol.js` | T — blow up message size or deadline | `MAX_BRIDGE_MESSAGE_BYTES` and `MAX_BRIDGE_TTL_MS` bound the inputs |
| `bridge-protocol.js` | D — degrade via an out-of-range core version | `evaluateCompatibility()` (#123) refuses `bridge.welcome` whose `coreVersion` falls outside the supported range; an incompatible welcome is logged and surfaces in the snapshot as `bridgeCompat.ok = false` |
| `bridge-auth.js` | S — tamper with envelope after signing | `stableJson()` canonicalises the payload before HMAC; `verifyBridgeEnvelopeAuth()` recomputes the canonical form and refuses on mismatch |
| `bridge-auth.js` | I — use the same envelope id with different payloads | `attachBridgeAuth()` writes `auth.envelopeHash` of the canonical JSON, so a payload swap invalidates the auth |
| `bridge-client.js` | E — use the bridge before pairing | `requirePairing()` refuses to construct the client without a valid pairing credential; service-worker discards bridge messages before pairing |
| `pairing-state.js` | S — tamper with persisted pairing | `loadOrCreatePairingState()` re-validates `installId` (`/^[a-f0-9]{64}$/i`) and the `pairing` shape (`/^[A-Za-z0-9_-]{43}$/`, `generation ≥ 1`); anything else is discarded and regenerated |
| `pairing-state.js` | T — accept a forged `bridge.paired` response | `acceptPairingResponse()` calls `verifyBridgeEnvelopeAuth()` before persisting |
| `control-state.js` | R — page content forces a transition | The state machine is constructed in the service worker; the popup reads snapshots over `chrome.runtime.sendMessage` and never writes |
| `control-state.js` | T — replay a stale user action | Audit log + monotonic counter in the snapshot |
| `site-authorizations.js` | S — canonicalise an origin to bypass a deny | `canonicalOrigin()` lower-cases the scheme and host, strips the default port, and drops the path |
| `site-authorizations.js` | T — reuse a `once` grant forever | The ONCE grant adds the origin to `onceUsed` on first dispatch |
| `settings.js` | I — store a secret in the settings blob | `KEY_ALLOWLIST` is the canonical key set; unknown keys are dropped on clean |
| `onboarding.js` | T — skip a required stage | `transitionOnboarding()` enforces the `STAGE_ORDER` graph; unknown targets are refused |
| `connection-doctor.js` | I — leak a secret in a doctor message | The doctor only inspects well-known boolean/string fields; it never inspects `pairing.secret`, `installId`, or paths |
| `popup.html` / `popup.js` | T — execute remote code | Popup CSP is `default-src 'self'`; no remote origins, no inline scripts; `popup.js` is loaded as a module |
| `popup.js` | T — let page content dispatch a `user-action` | `dispatch()` only sends to `chrome.runtime`; it never posts to `window.postMessage` or to a content script |
| `popup.js` | S — render attacker-controlled HTML | `renderAudit()` / `renderRegistry()` use `textContent`, not `innerHTML` |

## Cross-references

- Inventory of every privileged API the extension is allowed to call:
  [`extension-privileged-apis.md`](./extension-privileged-apis.md)
- Cross-boundary trust assumptions (EXT-NM-LOCAL-001 and friends):
  [`threat-model.md`](./threat-model.md)
- File-level regression matrix that pins every test in this document:
  [`test/extension-security-matrix.test.ts`](../../test/extension-security-matrix.test.ts)
  (#137 owns the extension security regression matrix)
- File-level control test for this document itself:
  [`test/extension-threat-model.test.ts`](../../test/extension-threat-model.test.ts)
  (#131 owns the extension threat model)
- The visible control-state machine lives in `popup.{html,js}` and is
  owned by `#125`; the popup reads canonical state from the service
  worker and never mutates it.
