import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

interface JsonRpcResponse {
  id?: number;
  result?: {
    content?: Array<{ type: string; text: string }>;
    isError?: boolean;
    serverInfo?: { name: string };
  };
  error?: { message: string };
}

const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/cli.js");

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
        const message = JSON.parse(line) as JsonRpcResponse;
        if (message.id !== undefined) {
          const resolve = this.pending.get(message.id);
          if (resolve) {
            this.pending.delete(message.id);
            resolve(message);
          }
        }
      } catch {
        // Ignore non-JSON child output.
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

  kill(): void {
    this.proc.kill();
  }
}

function buttonRef(snapshotText: string, label: string): string {
  const body = JSON.parse(snapshotText) as {
    snapshot: string;
    pageGeneration: number;
    snapshotGeneration: number;
  };
  assert.ok(body.pageGeneration > 0);
  assert.ok(body.snapshotGeneration > 0);
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = body.snapshot.match(new RegExp(`button "${escaped}" \\[ref=(\\w+)\\]`));
  assert.ok(match, `button ref for ${label} not found in snapshot:\n${body.snapshot}`);
  return match[1]!;
}

describe("E2E snapshot generation + pinned ref identity (#104)", () => {
  let client: McpClient;

  before(async () => {
    client = new McpClient();
    const init = await client.rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "e2e-ref-generation", version: "0.0.0" },
    });
    assert.equal(init.result?.serverInfo?.name, "orchords-web-pilot");
    client.notify("notifications/initialized");
  });

  after(() => client.kill());

  it("rejects a ref from a superseded snapshot even when the DOM is unchanged", async () => {
    await client.callTool("browser_navigate", {
      url: "data:text/html,<script>window.hit=0</script><button onclick='window.hit++'>Go</button>",
    });

    const firstSnapshot = await client.callTool("browser_snapshot", {});
    assert.equal(firstSnapshot.isError, false);
    const oldRef = buttonRef(firstSnapshot.text, "Go");

    const secondSnapshot = await client.callTool("browser_snapshot", {});
    assert.equal(secondSnapshot.isError, false);
    const currentRef = buttonRef(secondSnapshot.text, "Go");
    assert.notEqual(oldRef, currentRef, "new snapshots must mint a new ref generation");

    const staleClick = await client.callTool("browser_click", { ref: oldRef });
    assert.equal(staleClick.isError, true);
    assert.match(staleClick.text, /no longer valid|stale/i);

    const currentClick = await client.callTool("browser_click", { ref: currentRef });
    assert.equal(currentClick.isError, false);
    const hit = await client.callTool("browser_evaluate", { expression: "window.hit" });
    assert.equal((JSON.parse(hit.text) as { result: number }).result, 1);
  });

  it("rejects a ref when rerender replaces the captured DOM node with an equivalent target", async () => {
    await client.callTool("browser_navigate", {
      url: "data:text/html,<script>window.hit='none'</script><button id='b' onclick=\"window.hit='old'\">Submit</button>",
    });

    const snapshot = await client.callTool("browser_snapshot", {});
    assert.equal(snapshot.isError, false);
    const oldRef = buttonRef(snapshot.text, "Submit");

    const rerender = await client.callTool("browser_evaluate", {
      expression:
        "(() => { const old = document.getElementById('b'); const replacement = old.cloneNode(true); replacement.onclick = () => { window.hit = 'new'; }; old.replaceWith(replacement); return true; })()",
    });
    assert.equal(rerender.isError, false);

    const staleClick = await client.callTool("browser_click", { ref: oldRef });
    assert.equal(staleClick.isError, true);
    assert.match(staleClick.text, /detached|stale|snapshot/i);

    const untouched = await client.callTool("browser_evaluate", { expression: "window.hit" });
    assert.equal((JSON.parse(untouched.text) as { result: string }).result, "none");

    const freshSnapshot = await client.callTool("browser_snapshot", {});
    const freshRef = buttonRef(freshSnapshot.text, "Submit");
    const freshClick = await client.callTool("browser_click", { ref: freshRef });
    assert.equal(freshClick.isError, false);
    const hit = await client.callTool("browser_evaluate", { expression: "window.hit" });
    assert.equal((JSON.parse(hit.text) as { result: string }).result, "new");
  });

  it("rejects a still-connected DOM node that was recycled to different visible semantics", async () => {
    await client.callTool("browser_navigate", {
      url: "data:text/html,<script>window.hit='none'</script><button id='b' onclick='window.hit=this.textContent'>Approve</button>",
    });

    const snapshot = await client.callTool("browser_snapshot", {});
    const oldRef = buttonRef(snapshot.text, "Approve");
    await client.callTool("browser_evaluate", {
      expression: "(() => { document.getElementById('b').textContent = 'Revoke'; return true; })()",
    });

    const staleClick = await client.callTool("browser_click", { ref: oldRef });
    assert.equal(staleClick.isError, true);
    assert.match(staleClick.text, /no longer matches|stale|snapshot/i);

    const untouched = await client.callTool("browser_evaluate", { expression: "window.hit" });
    assert.equal((JSON.parse(untouched.text) as { result: string }).result, "none");

    const freshSnapshot = await client.callTool("browser_snapshot", {});
    const freshRef = buttonRef(freshSnapshot.text, "Revoke");
    const freshClick = await client.callTool("browser_click", { ref: freshRef });
    assert.equal(freshClick.isError, false);
    const hit = await client.callTool("browser_evaluate", { expression: "window.hit" });
    assert.equal((JSON.parse(hit.text) as { result: string }).result, "Revoke");
  });
});
