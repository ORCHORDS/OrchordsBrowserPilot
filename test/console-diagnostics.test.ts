import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConsoleMessage } from "playwright";
import { createDiagnostics } from "../src/browser.js";

function consoleMessage(
  type: string,
  text: string,
  timestamp = 1_780_000_000_123,
  location = { url: "https://example.test/app.js", line: 7, column: 11 },
): ConsoleMessage {
  return {
    type: () => type,
    text: () => text,
    timestamp: () => timestamp,
    location: () => location,
  } as unknown as ConsoleMessage;
}

describe("console diagnostics level fidelity (#22)", () => {
  it("includes Playwright 'warning' messages when caller requests warn threshold", () => {
    const diagnostics = createDiagnostics();
    diagnostics.onConsole(consoleMessage("warning", "careful"));
    diagnostics.onConsole(consoleMessage("error", "boom"));

    assert.deepEqual(
      diagnostics.console("warn", 10).map((message) => ({ level: message.level, text: message.text })),
      [
        { level: "warning", text: "careful" },
        { level: "error", text: "boom" },
      ],
    );
  });

  it("preserves raw type, normalized severity, Playwright timestamp, and source location", () => {
    const diagnostics = createDiagnostics();
    diagnostics.onConsole(consoleMessage("warning", "from source"));

    assert.deepEqual(diagnostics.console("warn", 10), [
      {
        level: "warning",
        severity: "warning",
        text: "from source",
        at: 1_780_000_000_123,
        location: {
          url: "https://example.test/app.js",
          line: 7,
          column: 11,
        },
      },
    ]);
  });
});
