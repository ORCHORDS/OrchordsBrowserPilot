# Browser Agent Threat Model

This document is a versioned security-assumption record for Orchords Web Pilot. It does not replace issue-specific controls or penetration testing; it makes cross-boundary assumptions explicit so release claims cannot silently exceed the guarantees of the underlying browser/OS platform.

## Local extension / Native Messaging deployment

### Assets
- Extension install identity and pairing credential.
- Native-host pairing records and replay state.
- Browser session state reachable through the canonical MCP/policy path.
- User data exposed to browser automation.

### Actors
- Legitimate Chrome/Edge extension install.
- Orchords native host running for the local OS user.
- Arbitrary web content and arbitrary extensions.
- Untrusted local processes running without access to the user's browser-profile secrets.
- A process running as the same fully compromised OS user/profile.

### Trust boundaries and data flow
1. Chrome/Edge resolves the registered Native Messaging host and enforces the host manifest `allowed_origins` list.
2. The extension and native host then establish Orchords' own cryptographic pairing and HMAC-authenticated envelopes.
3. The native host validates origin/install/profile binding, deadline/size/protocol constraints, HMAC and replay state before dispatch.
4. Authenticated requests enter the canonical MCP server, operation queue and policy gates; Native Messaging is not a parallel browser-command path.

### EXT-NM-LOCAL-001 — same-user local process impersonation

**Threat.** Chromium documents Native Messaging as not being a secure communication channel by itself. `allowed_origins` restricts which extension IDs Chrome may connect, but another local binary can launch the registered native host directly. A process that has already compromised the same OS user/profile may also be able to read or tamper with user-owned browser/profile state and local pairing material.

**Preventive controls.**
- Native Messaging is the only default extension transport; no unauthenticated localhost HTTP/WebSocket fallback.
- Host manifest uses explicit extension origins, never a wildcard.
- Pairing secrets are random, install-bound and profile-bound; plaintext secrets are not persisted by the host.
- Requests and responses are HMAC authenticated; stale generations, malformed/unsigned messages and replays are rejected before dispatch.
- Reinstall revokes the previous install pairing and creates a new credential.
- Browser actions still pass through canonical policy and operation-queue controls.

**Detective/regression controls.**
- `test/native-host-authenticated.test.ts` covers spoofed origin, stale pre-rotation credentials, replay after host restart, malformed/unauthenticated requests, signed cancellation and canonical dispatch behavior.
- Extension pairing/auth tests cover authenticated host responses and reinstall/re-pair behavior.

**Security boundary.** Arbitrary websites, arbitrary extensions and local processes that do not possess the active pairing secret are in scope and must not be able to dispatch browser actions. A process that already controls the same OS user/profile is treated as a local-user compromise: portable Chrome/Edge Native Messaging does not provide cryptographic browser-process attestation against that actor. Such compromise can expose browser-profile and user-owned local secrets beyond this bridge alone.

**Release gate.** Commercial/local-extension release notes and security assumptions MUST state this local-user-compromise boundary unless a platform-specific, OS-backed/non-exportable attestation or broker control is added and independently reviewed. A release MUST NOT claim resistance to a fully compromised same-user profile solely because Native Messaging `allowed_origins` and argv caller-origin checks are present.

**Owners.** #123 owns extension↔core authenticated bridge controls; #91 owns the cross-product threat model/release-assurance policy; #131 owns extension manifest/permission security; #137 owns extension security regression coverage.

## Architecture review trigger

Any change that adds a new native transport, credential location, extension permission, browser provider, public listener, remote execution path, or way to bypass the canonical MCP/policy dispatcher requires a security-architecture review before release and an update to this threat model if the trust boundary changes.
