import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDiagnostics } from "../src/browser.js";

describe("network static-resource filtering (#19)", () => {
  it("excludes real Playwright static resource types when static=false", () => {
    const diagnostics = createDiagnostics();
    diagnostics.onRequestFinished("https://example.test/app.js", "GET", 200, "script");
    diagnostics.onRequestFinished("https://example.test/app.css", "GET", 200, "stylesheet");
    diagnostics.onRequestFinished("https://example.test/logo.png", "GET", 200, "image");
    diagnostics.onRequestFinished("https://example.test/font.woff2", "GET", 200, "font");
    diagnostics.onRequestFinished("https://example.test/api/user", "GET", 200, "xhr");

    assert.deepEqual(
      diagnostics.network(false, 20).map((request) => request.type),
      ["xhr"],
    );
  });
});
