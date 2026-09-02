# Extension Runtime Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the first independently testable slice of #122: a minimal, installable Chrome/Edge Manifest V3 extension package boundary that is validated by the repository test suite without duplicating browser automation logic.

**Architecture:** Keep `src/` as the Web Pilot core. Add a separate `extension/` package boundary containing only Manifest V3 browser-shell concerns. The service worker is intentionally event-driven and stateless in this slice because MV3 workers can be suspended; provider/session/bridge state will be added by #123/#126/#130. No host permissions, debugger permission, native messaging permission, content scripts, or side-panel permission are introduced in this slice.

**Tech Stack:** Chrome/Edge Manifest V3, JavaScript service worker, Node test runner already used by the repository.

**Spec:** GitHub issue #122 (`P0: Add first-class Chrome/Edge MV3 extension runtime as a Web Pilot browser provider`).

## Global Constraints

- Work directly on `main`; no feature branches.
- Do not duplicate Web Pilot tool implementations inside the extension.
- Request no site/privileged permissions until their canonical issues (#123/#124/#131/#132) are implemented and verified.
- Treat MV3 service-worker suspension as normal lifecycle behavior; do not rely on persistent globals for correctness.
- Keep Chrome and Edge on one source tree.
- Every production change follows RED -> GREEN TDD and the exact commit must complete CI before the next slice lands.

---

### Task 1: Define and validate the minimal MV3 package boundary

**Files:**
- Create: `test/extension-manifest.test.ts`
- Create: `extension/manifest.json`
- Create: `extension/service-worker.js`

**Interfaces:**
- Consumes: existing Node test runner and repository package scripts.
- Produces: an MV3 manifest whose background service worker is `service-worker.js`, with no host permissions or privileged permissions in the foundation slice.

- [ ] **Step 1: Write the failing test**

Create `test/extension-manifest.test.ts` that loads `extension/manifest.json` and asserts: `manifest_version === 3`; non-empty name/version; `background.service_worker === "service-worker.js"`; service-worker file exists; no `host_permissions`; no broad `<all_urls>`/`debugger`/`nativeMessaging`/`scripting` permissions are present.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/extension-manifest.test.ts`
Expected: FAIL because `extension/manifest.json` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create a valid `extension/manifest.json` with MV3, product name/description/version, `background.service_worker`, and `action.default_title`; create a small `extension/service-worker.js` that registers deterministic install/startup diagnostic logging only and stores no authority/session state.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/extension-manifest.test.ts`
Expected: PASS.

- [ ] **Step 5: Run repository verification**

Run: `npm run build && npm run lint && npm test`
Expected: PASS with no new warnings/errors.

- [ ] **Step 6: Commit**

Commit message: `feat(extension): add minimal MV3 runtime foundation`

### Task 2: Keep the package contract source-synchronized

**Files:**
- Modify: `package.json`
- Modify: `test/extension-manifest.test.ts`

**Interfaces:**
- Produces: a deterministic `npm run extension:check` command used locally/CI without adding a bundler yet.

- [ ] **Step 1: Write the failing test**

Extend the manifest test to assert the extension version equals the root package version and that every file named by the manifest exists under `extension/`.

- [ ] **Step 2: Run test to verify it fails if the version/file contract is inconsistent**

Run: `npm test -- test/extension-manifest.test.ts`.

- [ ] **Step 3: Add the smallest script/config changes needed**

Add `extension:check` to `package.json` invoking the dedicated manifest test; keep the extension dependency-free and unbundled for this slice.

- [ ] **Step 4: Verify green**

Run: `npm run extension:check && npm run build && npm run lint && npm test`.

- [ ] **Step 5: Commit**

Commit message: `test(extension): enforce MV3 package contract`
