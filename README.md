<p align="center">
  <img src="https://raw.githubusercontent.com/ORCHORDS/docs/main/assets/1080x360.jpg" width="1080" alt="ORCHORDS — BUILD DIFFERENT.">
</p>

# Orchords Web Pilot

[![Main verification](https://github.com/ORCHORDS/orchords-web-pilot/actions/workflows/main-verification.yml/badge.svg)](https://github.com/ORCHORDS/orchords-web-pilot/actions/workflows/main-verification.yml)
[![Daily build](https://github.com/ORCHORDS/orchords-web-pilot/actions/workflows/daily-build.yml/badge.svg)](https://github.com/ORCHORDS/orchords-web-pilot/actions/workflows/daily-build.yml)
[![CodeQL](https://github.com/ORCHORDS/orchords-web-pilot/actions/workflows/codeql.yml/badge.svg)](https://github.com/ORCHORDS/orchords-web-pilot/actions/workflows/codeql.yml)
[![Dependency audit](https://github.com/ORCHORDS/orchords-web-pilot/actions/workflows/dependency-audit.yml/badge.svg)](https://github.com/ORCHORDS/orchords-web-pilot/actions/workflows/dependency-audit.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

> ⭐ If you like Orchords Web Pilot or find it useful, please consider starring this repository. It helps more people discover the project.

> **Interested in sponsoring ORCHORDS?** Sponsorships start at **US$1,000**. Depending on the sponsorship level, sponsors may receive public recognition, logo and website placement, sponsor updates and early previews, roadmap-feedback briefings, priority issue triage, and engineering or integration discussions. Sponsorship does not buy control of the roadmap or guarantee feature implementation. Contact **[crm@orchords.com](mailto:crm@orchords.com)**.

**Independent software studio founded in 2025.**

> A Model Context Protocol server that gives coding agents a real browser — navigate, observe, interact, and capture proof on any web page through one transport-agnostic surface.

Orchords Web Pilot is a [Model Context Protocol](https://modelcontextprotocol.io) server that exposes a Playwright-backed browser session as a set of agent-friendly tools. Point your agent at it and it can navigate, observe, interact, and capture proof on any web page — same model across local and hosted browsers, same surface across stdio and Streamable HTTP transports.

## Start here

| If you need… | Start with |
| --- | --- |
| Install and first run | [Install](#install) |
| Wire it into a desktop agent | [stdio (default)](#stdio-default--desktop-agents) |
| Run it as a hosted service | [Streamable HTTP](#streamable-http-hosted--shared) |
| Use a remote browser grid | [Local or remote browser](#local-or-remote-browser) |
| Available tools and parameters | [Tools](#tools) · [Configuration](#configuration) |
| Security guidance | [Security](#security) · [SECURITY.md](./SECURITY.md) |
| Contributing process | [Contributing](#contributing) |

## Capabilities

- Real Chromium session — local via Playwright **or** remote via any WebSocket endpoint (Browserless, hosted Chrome, your own grid)
- Small, well-typed tool surface — navigate, snapshot, click, type, screenshot, drag, press-key, hover, evaluate JS, capture console + network, fill forms, manage tabs
- One transport for everything — stdio for desktop agents, Streamable HTTP for hosted and multi-user setups
- Auto-detection — set `BROWSER_WS_ENDPOINT` to flip to a remote browser; everything else stays the same
- Accessibility-first — every interaction accepts an element target from the agent's snapshot, not raw pixel coordinates

## Install

```bash
npm install -g orchords-web-pilot
```

Or run it straight from a checkout:

```bash
git clone https://github.com/ORCHORDS/orchords-web-pilot.git
cd orchords-web-pilot
npm install
npm run build
npm start
```

## Usage

### stdio (default — desktop agents)

Add to your MCP client config (Claude Desktop, ZCode, etc.):

```json
{
  "mcpServers": {
    "orchords-web-pilot": {
      "command": "orchords-web-pilot",
      "env": {
        "PILOT_HEADLESS": "true"
      }
    }
  }
}
```

### Streamable HTTP (hosted / shared)

```bash
PILOT_TRANSPORT=http \
PILOT_HTTP_HOST=0.0.0.0 \
PILOT_HTTP_PORT=8788 \
PILOT_HTTP_PATH=/mcp \
npm start
```

Then point your client at `http://<host>:8788/mcp`.

### Local or remote browser

By default Web Pilot launches a local Chromium via Playwright. To use a remote
browser (Browserless, hosted Chrome, your own grid), set:

```bash
export BROWSER_WS_ENDPOINT="wss://chrome.browserless.io?token=..."
```

The server auto-detects: if `BROWSER_WS_ENDPOINT` is set it connects to that;
otherwise it spins up a local browser.

## Tools

| Tool                    | What it does                                                |
| ----------------------- | ----------------------------------------------------------- |
| `browser_navigate`      | Open a URL.                                                 |
| `browser_snapshot`      | Return an accessibility tree (preferred for agent planning).|
| `browser_click`         | Click by ref, selector, or coordinate.                      |
| `browser_type`          | Type into the focused element.                              |
| `browser_fill`          | Set an input value directly.                                |
| `browser_press`         | Press a key (Enter, Tab, Escape, arrow keys…).              |
| `browser_hover`         | Hover an element.                                           |
| `browser_drag`          | Drag from one element to another.                           |
| `browser_select`        | Choose an `<option>` in a `<select>`.                       |
| `browser_screenshot`    | Capture PNG (returns base64 or saves to disk).              |
| `browser_evaluate`      | Run a JS expression in the page context.                    |
| `browser_console`       | Read console messages since the page loaded.                |
| `browser_network`       | List captured network requests with bodies.                 |
| `browser_wait`          | Wait for text, selector, or a fixed duration.               |
| `browser_tabs`          | List / open / close / switch tabs.                          |
| `browser_captcha_solve` | Plug into an external captcha-solving service.              |

> The captcha-solver tool is a hook: it reads `PILOT_CAPTCHA_SOLVER_URL` and `PILOT_CAPTCHA_SOLVER_TOKEN` and forwards the challenge. Wire in your own provider (2Captcha, AntiCaptcha, your own microservice) — the MVP does not ship a default to keep the licensing surface clean.

## Configuration

All config is via environment variables. See [`.env.example`](./.env.example).

| Variable                     | Default       | Notes                                       |
| ---------------------------- | ------------- | ------------------------------------------- |
| `PILOT_TRANSPORT`            | `stdio`       | `stdio` or `http`.                          |
| `PILOT_HTTP_HOST`            | `127.0.0.1`   | HTTP transport only.                        |
| `PILOT_HTTP_PORT`            | `8788`        | HTTP transport only.                        |
| `PILOT_HTTP_PATH`            | `/mcp`        | HTTP transport only.                        |
| `PILOT_HEADLESS`             | `true`        | Set `false` to watch the agent work.        |
| `BROWSER_WS_ENDPOINT`        | _(unset)_     | Set to use a remote browser.                |
| `PILOT_CAPTCHA_SOLVER_URL`   | _(unset)_     | Captcha solver endpoint.                    |
| `PILOT_CAPTCHA_SOLVER_TOKEN` | _(unset)_     | Captcha solver bearer token.                |

## Development

```bash
npm install
npm run dev      # tsx watch
npm run lint
npm test
```

## Security

Web Pilot is **opt-in remote-capable**. The HTTP transport binds to `127.0.0.1` by default; change to `0.0.0.0` only behind auth. Never expose it on the public internet without putting a reverse proxy + auth in front.

See [SECURITY.md](./SECURITY.md).

## Documentation boundary

Product-specific engineering guidance lives in this repository. Company-wide public engineering, security, governance, and operational documentation is maintained in [`ORCHORDS/docs`](https://github.com/ORCHORDS/docs).

## Contributing

Issues and PRs welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Brand

**ORCHORDS — BUILD DIFFERENT.**

## License

Licensed under the [Apache License 2.0](LICENSE).
