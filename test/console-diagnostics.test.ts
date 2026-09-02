import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConsoleMessage } from "playwright";
import { createDiagnostics } from "../src/browser.js";

function consoleMessage(type: string, text: string): ConsoleMessage {
  return {
    type: () => type,
    text: () => text,
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
});
