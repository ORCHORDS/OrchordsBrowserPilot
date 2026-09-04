# Security Policy

## Reporting a Vulnerability

Please report security issues privately to **security@orchords.com**. Do not file public GitHub issues containing vulnerability details.

Our response targets are to acknowledge reports within 2 business days and to provide a fix or mitigation plan within 30 days for critical issues. These are operational targets, not guarantees.

## Current Trust Model

Orchords Web Pilot currently targets trusted local-development and controlled self-hosting scenarios. It is not yet a complete multi-tenant, internet-facing security boundary.

Out of the box:

- The HTTP transport binds to `127.0.0.1` and public binding must be explicitly enabled.
- Local Chromium is launched through Playwright, but the current source does not currently explicitly enable Chromium's process sandbox. Treat browser execution as having the privileges of the account running Web Pilot until the isolation work tracked in [#106](https://github.com/ORCHORDS/OrchordsBrowserPilot/issues/106) is complete.
- When `BROWSER_WS_ENDPOINT` is used, the remote provider owns the browser process and its isolation posture. Web Pilot does not currently prove that a provider-managed browser is sandboxed.
- Origin/Host validation, request limits, and related HTTP hardening reduce exposure, but they do not replace authentication, authorization, browser isolation, egress policy, or secret handling.

Do not expose Web Pilot directly to an untrusted network. If you enable a public bind or place it behind an internet-facing endpoint, put it behind an authenticating reverse proxy and apply appropriate network, filesystem, secret, and browser-isolation controls.

Security hardening still in progress is tracked in the public issues for authentication/authorization ([#42](https://github.com/ORCHORDS/OrchordsBrowserPilot/issues/42)), network egress/SSRF policy ([#45](https://github.com/ORCHORDS/OrchordsBrowserPilot/issues/45)), filesystem and dangerous-code policy ([#46](https://github.com/ORCHORDS/OrchordsBrowserPilot/issues/46)), prompt-injection/exfiltration defenses ([#80](https://github.com/ORCHORDS/OrchordsBrowserPilot/issues/80)), and browser/worker isolation ([#106](https://github.com/ORCHORDS/OrchordsBrowserPilot/issues/106)).
