import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

interface JsonRpcResponse {
  id?: number;
  result?: {
    content?: Array<{ type: string; text: string }>;
    isError?: boolean;
    serverInfo?: { name: string };
  };
}

class McpClient {
  private readonly proc: ChildProcess;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, (response: JsonRpcResponse) => void>();

  constructor() {
    this.proc = spawn(process.execPath, [cliPath], { stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stderr!.on("data", () => undefined);
    this.proc.stdout!.on("data", (chunk) => this.onChunk(chunk));
  }

  private onChunk(chunk: Buffer): void {
    this.buffer += chunk.toString();
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as JsonRpcResponse;
      if (message.id !== undefined) {
        this.pending.get(message.id)?.(message);
        this.pending.delete(message.id);
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

  async callTool(name: string, args: unknown): Promise<{ text: string; isError: boolean }> {
    const response = await this.rpc("tools/call", { name, arguments: args });
    const content = response.result?.content ?? [];
    return { text: content[0]?.text ?? "", isError: response.result?.isError === true };
  }

  close(): void {
    this.proc.kill();
  }
}

describe("browser_type keyboard semantics (#55)", () => {
  let client: McpClient;

  before(async () => {
    client = new McpClient();
    const init = await client.rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "type-semantics-e2e", version: "0.0.0" },
    });
    assert.equal(init.result?.serverInfo?.name, "orchords-web-pilot");
    client.notify("notifications/initialized");
  });

  after(() => client.close());

  it("selector-targeted browser_type emits keyboard events instead of fill-only input", async () => {
    const html = `<!doctype html><input id="target"><script>
      globalThis.__events = [];
      const input = document.querySelector('#target');
      for (const eventName of ['keydown', 'input', 'keyup']) {
        input.addEventListener(eventName, event => globalThis.__events.push(eventName + ':' + (event.key || input.value)));
      }
    </script>`;
    const nav = await client.callTool("browser_navigate", { url: `data:text/html,${encodeURIComponent(html)}` });
    assert.equal(nav.isError, false, nav.text);

    const typed = await client.callTool("browser_type", {
      selector: "#target",
      text: "ab",
      slowly: true,
    });
    assert.equal(typed.isError, false, typed.text);

    const observed = await client.callTool("browser_evaluate", {
      expression: "({ value: document.querySelector('#target').value, events: globalThis.__events })",
    });
    assert.equal(observed.isError, false, observed.text);
    const result = JSON.parse(observed.text) as { result: { value: string; events: string[] } };

    assert.equal(result.result.value, "ab");
    assert.deepEqual(
      result.result.events.map((event) => event.split(':')[0]),
      ["keydown", "input", "keyup", "keydown", "input", "keyup"],
    );
  });
});
