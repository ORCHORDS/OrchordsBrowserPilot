# Security Policy

## Reporting a Vulnerability

Please email security issues to **security@orchords.com** (replace with the
real address once configured). Do not file public GitHub issues for
vulnerabilities.

We aim to acknowledge reports within 2 business days and ship a fix or
mitigation within 30 days for critical issues.

## Trust Model

Orchords Web Pilot is a **local-developer tool**. Out of the box it:

- Binds the HTTP transport to `127.0.0.1`.
- Launches a sandboxed Chromium via Playwright.
- Does **not** phone home, log keystrokes, or persist page contents.

You expose it to the world at your own risk. If you set
`PILOT_HTTP_HOST=0.0.0.0` or put it behind a public reverse proxy, you must
add authentication — anyone with network access will be able to drive the
browser with full local-user privileges.
