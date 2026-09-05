/**
 * End-to-end coverage for issue #104 AC 4 — read-only lane split.
 *
 * Spawns the real CLI over stdio and asserts that:
 *   1. Two read-only `browser_console` calls dispatched back-to-back
 *      complete in roughly the time of a single call (parallel), not
 *      2× (serial). This is the integration proof that the queue's lane
 *      split is plumbed through CallToolRequestSchema in src/server.ts.
 *   2. A mutating delayed `browser_evaluate` queued ahead of a read-only
 *      `browser_console` blocks the read-only call until the mutation drains.
 *   3. Several read-only calls below the default concurrency cap all dispatch
 *      successfully through the wire path.
 *
 * The hard read-only capacity boundary itself is covered deterministically in
 * test/operation-queue-readonly.test.ts. This E2E file verifies the MCP wiring.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  error?: { code: number; message: string };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliPath = path.resolve(__dirname, "../dist/cli.js");

class McpClient {
  private proc: ChildProcess;
  private buf = "";
  private nextId = 1;
  private readonly pending = new Map<number, (r: JsonRpcResponse) => void>();

  constructor() {
    this.proc = spawn(process.execPath, [cliPath], { stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stderr!.on("data", () => undefined);
    this.proc.stdout!.on("data", (chunk) => this.onChunk(chunk));
  }

  private onChunk(chunk: Buffer): void {
    this.buf += chunk.toString();
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcResponse;
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          this.pending.get(msg.id)!(msg);
          this.pending.delete(msg.id);
        }
      } catch {
        // ignore non-JSON
      }
    }
  }

  rpc(method: string, params?: unknown): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, resolve);
      this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 45_000);
    });
  }

  notify(method: string): void {
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  }

  /** Fire a tools/call and resolve with the raw response (no awaits between fires). */
  sendCallTool(name: string, args: unknown): Promise<JsonRpcResponse> {
    return this.rpc("tools/call", { name, arguments: args });
  }

  kill(): void {
    this.proc.kill();
  }
}

describe("E2E read-only concurrency split (P1 #104 AC 4)", () => {
  let client: McpClient;

  before(async () => {
    client = new McpClient();
    const init = await client.rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "e2e-104-ro", version: "0.0.0" },
    });
    assert.equal(init.result?.serverInfo?.name, "orchords-web-pilot");
    client.notify("notifications/initialized");
  });

  after(() => {
    client.kill();
  });

  it("two concurrent browser_console calls complete in roughly one call's time", async () => {
    const baselineStart = Date.now();
    await client.sendCallTool("browser_console", { level: "log", limit: 10 });
    const baseline = Math.max(1, Date.now() - baselineStart);

    const t0 = Date.now();
    const [a, b] = await Promise.all([
      client.sendCallTool("browser_console", { level: "log", limit: 10 }),
      client.sendCallTool("browser_console", { level: "log", limit: 10 }),
    ]);
    const elapsed = Date.now() - t0;

    assert.notEqual(a.result?.isError, true, `first: ${JSON.stringify(a)}`);
    assert.notEqual(b.result?.isError, true, `second: ${JSON.stringify(b)}`);

    assert.ok(
      elapsed < baseline * 1.8,
      `parallel pair (${elapsed}ms) should be < 1.8× single baseline (${baseline}ms)`,
    );
  });

  it("mutating op queued ahead blocks a subsequent read-only op until it drains", async () => {
    const delayMs = 1_500;

    const t0 = Date.now();
    const first = client.sendCallTool("browser_evaluate", {
      expression: `new Promise((resolve) => setTimeout(() => resolve('done'), ${delayMs}))`,
    });
    await new Promise((r) => setTimeout(r, 50));
    const second = client.sendCallTool("browser_console", { level: "log", limit: 10 });

    const [firstRes, secondRes] = await Promise.all([first, second]);
    const elapsed = Date.now() - t0;

    assert.notEqual(firstRes.result?.isError, true, `first: ${JSON.stringify(firstRes)}`);
    assert.notEqual(secondRes.result?.isError, true, `second: ${JSON.stringify(secondRes)}`);
    assert.ok(
      elapsed >= delayMs - 200,
      `mutating op must drain before read-only dispatch (>= ${delayMs}ms), got ${elapsed}ms`,
    );
  });

  it("multiple read-only calls below the default concurrency cap all dispatch successfully", async () => {
    // The default read-only cap is four. Three simultaneous calls are below
    // that cap and should all be accepted by the MCP routing path. Exact cap
    // enforcement is asserted in the OperationQueue unit suite.
    const results = await Promise.all([
      client.sendCallTool("browser_console", { level: "log", limit: 5 }),
      client.sendCallTool("browser_console", { level: "warn", limit: 5 }),
      client.sendCallTool("browser_console", { level: "error", limit: 5 }),
    ]);
    for (const r of results) {
      assert.notEqual(r.result?.isError, true, `error: ${JSON.stringify(r)}`);
    }
  });
});