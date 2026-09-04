import assert from "node:assert/strict";
import test from "node:test";

import type { BrowserManager } from "../src/browser.js";
import { CanonicalMcpBridge } from "../src/canonical-mcp-bridge.js";
import { Session } from "../src/session.js";

function noPageManager(): BrowserManager {
  return {
    async page() {
      throw new Error("no browser page required for this test");
    },
    async close() {},
  };
}

test("native bridge tool calls traverse the same MCP buildServer queue/policy path (#123)", async () => {
  const session = new Session("native-bridge-test", noPageManager());
  const bridge = await CanonicalMcpBridge.create(session, {}, { policyMode: "audit" });
  try {
    const before = session.ops.stats().completed;
    const result = await bridge.callTool("browser_console", { level: "log", limit: 10 });
    assert.equal(result.isError, undefined);
    assert.equal(session.ops.stats().completed, before + 1);
    const block = result.content[0];
    assert.equal(block?.type, "text");
    if (block?.type === "text") assert.equal(block.text, "{\"messages\":[]}");
  } finally {
    await bridge.close();
    await session.dispose();
  }
});

test("native bridge cannot invoke a tool outside the server's advertised tool set (#123)", async () => {
  const session = new Session("native-bridge-unknown", noPageManager());
  const bridge = await CanonicalMcpBridge.create(session, {}, { policyMode: "audit" });
  try {
    const result = await bridge.callTool("not_a_real_tool", {});
    assert.equal(result.isError, true);
    const block = result.content[0];
    assert.equal(block?.type, "text");
    if (block?.type === "text") assert.match(block.text, /unknown tool/i);
  } finally {
    await bridge.close();
    await session.dispose();
  }
});
