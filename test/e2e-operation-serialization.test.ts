/**
 * End-to-end coverage for issue #104 — per-session operation serialization.
 *
 * Spawns the real CLI over stdio, fires delayed mutating `browser_evaluate`
 * calls on the same session without awaiting the first response, and asserts
 * that they serialize through the single mutating lane. `browser_wait` is
 * intentionally read-only after the AC 4 lane split, so it must not be used
 * as a serialization fixture here.
 *
 * This is the integration-level proof that the wire-up works: the queue is
 * plumbed into CallToolRequestSchema and mutating page work cannot overlap
 * accidentally inside one session/page.
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

function delayedEvaluate(delayMs: number): { expression: string } {
  return {
    expression: `new Promise((resolve) => setTimeout(() => resolve(${delayMs}), ${delayMs}))`,
  };
}

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

describe("E2E per-session operation serialization (P1 #104)", () => {
  let client: McpClient;

  before(async () => {
    client = new McpClient();
    const init = await client.rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "e2e-104", version: "0.0.0" },
    });
    assert.equal(init.result?.serverInfo?.name, "orchords-web-pilot");
    client.notify("notifications/initialized");
  });

  after(() => {
    client.kill();
  });

  it("two concurrent mutating evaluations on the same session serialize (FIFO)", async () => {
    const delayMs = 1_500;

    const t0 = Date.now();
    const first = client.sendCallTool("browser_evaluate", delayedEvaluate(delayMs));
    // Tiny gap keeps arrival order deterministic while remaining much shorter
    // than the blocker itself.
    await new Promise((r) => setTimeout(r, 50));
    const second = client.sendCallTool("browser_evaluate", delayedEvaluate(delayMs));

    const [firstRes, secondRes] = await Promise.all([first, second]);
    const elapsed = Date.now() - t0;

    assert.notEqual(firstRes.result?.isError, true, `first: ${JSON.stringify(firstRes)}`);
    assert.notEqual(secondRes.result?.isError, true, `second: ${JSON.stringify(secondRes)}`);

    // Playwright waits for a Promise returned by page.evaluate. Two mutating
    // evaluations therefore take roughly 2 × delayMs when the single
    // mutating lane is correctly wired, but roughly delayMs if they overlap.
    assert.ok(
      elapsed >= delayMs * 2 - 200,
      `expected sequential execution (>= ${delayMs * 2}ms), got ${elapsed}ms`,
    );
    // No wall-clock upper bound: host/CI contention may stretch elapsed time.
  });

  it("rapid-fire mutating calls all serialize without errors", async () => {
    const count = 5;
    const delayMs = 400;
    const promises: Promise<JsonRpcResponse>[] = [];
    const t0 = Date.now();
    for (let i = 0; i < count; i++) {
      promises.push(client.sendCallTool("browser_evaluate", delayedEvaluate(delayMs)));
    }
    const results = await Promise.all(promises);
    const elapsed = Date.now() - t0;

    for (const r of results) {
      assert.notEqual(r.result?.isError, true, `error in burst: ${JSON.stringify(r)}`);
    }
    assert.ok(
      elapsed >= count * delayMs - 250,
      `expected sequential execution (>= ${count * delayMs}ms), got ${elapsed}ms`,
    );
  });
});