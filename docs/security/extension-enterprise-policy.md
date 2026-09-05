# Extension Enterprise Policy (#139)

This document is the product-side policy for how Orchords Web Pilot behaves
in incognito windows, multi-profile setups, and enterprise-managed browser
deployments. It is **owned by `#139`** (incognito / multi-profile /
enterprise-managed policy, P2) and is **pinned by
`test/extension-enterprise-policy.test.ts`**.

The product does NOT request the `incognito` permission (`"split_mode"` or
`"spanning"`) — by default the extension refuses to run inside an incognito
window. Users who want incognito control must enable it explicitly via
`chrome://extensions` → Orchords Web Pilot → "Allow in incognito", and the
companion core will then mirror that decision in its session manifest.

## Multi-profile behaviour

- Each Chrome/Edge profile gets its own `chrome.storage.local` partition.
  The extension never reads from or writes to a different profile's
  storage.
- The pairing credential is profile-scoped; resetting pairing in one
  profile does not affect another.
- A user who logs into multiple browser profiles must re-pair the
  companion core from each profile separately. The companion host
  surfaces the per-profile pairing state in its own diagnostic panel.

## Enterprise-managed browsers

- The extension honors `chrome.storage.managed` when an IT admin sets
  policies; the extension reads `interfaceDensity` and `diagnosticsOptIn`
  from managed storage before applying user overrides.
- The companion core, not the extension, is the trust anchor for enterprise
  sign-in (SAML / SSO). The extension never reads identity tokens.

## Invariants

| Invariant | Owner |
| --------- | ----- |
| Manifest does not request the `incognito` permission | `#131` |
| Pairing is per-profile | `#123` |
| Managed storage override is read at most once per SW wakeup | `#130` |
| Enterprise sign-in is the companion's responsibility | `#132` |
