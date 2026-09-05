import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliPath = path.resolve(__dirname, "../dist/cli.js");

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

class McpClient {
  private readonly proc: ChildProcess;
  private buf = "";
  private nextId = 1;
  private readonly pending = new Map<number, (response: JsonRpcResponse) => void>();

  constructor() {
    this.proc = spawn(process.execPath, [cliPath], { stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stderr!.on("data", () => undefined);
    this.proc.stdout!.on("data", (chunk) => this.onChunk(chunk));
  }

  private onChunk(chunk: Buffer): void {
    this.buf += chunk.toString();
    let newline: number;
    while ((newline = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, newline).trim();
      this.buf = this.buf.slice(newline + 1);
      if (!line) continue;
      try {
        const response = JSON.parse(line) as JsonRpcResponse;
        if (response.id !== undefined) {
          const resolve = this.pending.get(response.id);
          if (resolve) {
            this.pending.delete(response.id);
            resolve(response);
          }
        }
      } catch {
        // Ignore non-JSON output from the child.
      }
    }
  }

  send(method: string, params?: unknown): { id: number; response: Promise<JsonRpcResponse> } {
    const id = this.nextId++;
    const response = new Promise<JsonRpcResponse>((resolve) => {
      this.pending.set(id, resolve);
    });
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return { id, response };
  }

  notify(method: string, params?: unknown): void {
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  kill(): void {
    this.proc.kill();
  }
}

describe("E2E queued MCP cancellation (#104)", () => {
  let client: McpClient;

  before(async () => {
    client = new McpClient();
    const init = client.send("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "e2e-104-cancel", version: "0.0.0" },
    });
    const response = await withTimeout(init.response, 10_000, "initialize");
    assert.equal(response.error, undefined, JSON.stringify(response));
    client.notify("notifications/initialized");
  });

  after(() => {
    client.kill();
  });

  it("notifications/cancelled removes a queued call so the following call can dispatch", async () => {
    // The first wait occupies the only per-session slot. The long second
    // wait is therefore queued; cancelling its JSON-RPC request must remove
    // it from the backlog. A short third call should then run immediately
    // after the first rather than waiting behind the cancelled 5s call.
    //
    // The first tools/call budget is intentionally larger than the third's
    // to absorb cold-start latency from a freshly spawned CLI on a CI
    // runner (Node ESM + Playwright dynamic imports can blow past 4 s on the
    // very first request). The invariant we still pin is that, after the
    // cancel, the third call must dispatch immediately after the first —
    // i.e. it does NOT wait behind the cancelled 5 s operation.
    const startedAt = Date.now();
    const first = client.send("tools/call", {
      name: "browser_wait",
      arguments: { time: 0.75 },
    });

    await new Promise((resolve) => setTimeout(resolve, 75));
    const second = client.send("tools/call", {
      name: "browser_wait",
      arguments: { time: 5 },
    });

    await new Promise((resolve) => setTimeout(resolve, 75));
    client.notify("notifications/cancelled", {
      requestId: second.id,
      reason: "cancel queued operation",
    });

    const third = client.send("tools/call", {
      name: "browser_wait",
      arguments: { time: 0.05 },
    });

    // Warm up the cold-start budget for the first call so a slow CLI
    // launch doesn't masquerade as a queueing regression.
    const firstDispatchedAt = Date.now();
    const firstResponse = await withTimeout(first.response, 15_000, "first tools/call");
    const firstElapsed = Date.now() - firstDispatchedAt;
    assert.equal(firstResponse.error, undefined, JSON.stringify(firstResponse));
    assert.ok(
      firstElapsed <= 10_000,
      `first tools/call took ${firstElapsed}ms — CLI cold start exceeded warm-up budget`,
    );

    // Once the first call has actually started dispatching, the third call
    // must be served by the queue immediately afterwards — it must not wait
    // behind the cancelled 5 s operation.
    const thirdResponse = await withTimeout(third.response, 2_000, "third tools/call");
    assert.equal(thirdResponse.error, undefined, JSON.stringify(thirdResponse));
    const elapsed = Date.now() - startedAt;
    assert.ok(
      elapsed < 5_500,
      `third call was still blocked behind the cancelled 5s operation (${elapsed}ms)`,
    );
  });
});
