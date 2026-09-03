import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * End-to-end coverage for issue #1 (state persistence) and issue #2 (ref
 * resolution) through the real stdio transport: spawn dist/cli.js, speak
 * JSON-RPC, and prove that navigate -> snapshot -> click -> evaluate all
 * operate on the SAME page and that snapshot refs resolve to real elements.
 *
 * This test requires `npm run build` to have produced dist/cli.js — CI runs
 * build before test, and locally `npm test` is documented to assume it.
 */

const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

interface JsonRpcResponse {
  id?: number;
  result?: {
    content?: Array<{ type: string; text: string }>;
    isError?: boolean;
    tools?: unknown[];
    serverInfo?: { name: string };
  };
  error?: { message: string };
}

class McpClient {
  private proc: ChildProcess;
  private buf = "";
  private nextId = 1;
  private readonly pending = new Map<number, (r: JsonRpcResponse) => void>();

  constructor() {
    this.proc = spawn(process.execPath, [cliPath], { stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stderr!.on("data", () => undefined); // keep stderr drained
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
        // non-JSON line — ignore
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
    const res = await this.rpc("tools/call", { name, arguments: args });
    const content = res.result?.content ?? [];
    return { text: content[0]?.text ?? "", isError: res.result?.isError === true };
  }

  kill(): void {
    this.proc.kill();
  }
}

describe("E2E stdio (P0 #1 state persistence + #2 ref resolution)", () => {
  let client: McpClient;

  before(async () => {
    client = new McpClient();
    const init = await client.rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "e2e-test", version: "0.0.0" },
    });
    assert.equal(init.result?.serverInfo?.name, "orchords-web-pilot");
    client.notify("notifications/initialized");
  });

  after(() => {
    client.kill();
  });

  it("lists 17 tools with valid JSON Schemas", async () => {
    const res = await client.rpc("tools/list", {});
    const tools = res.result?.tools as Array<{ name: string; inputSchema: Record<string, unknown> }>;
    assert.equal(tools.length, 17);
    // #81 policy plumbing must be part of the advertised surface.
    const names = tools.map((t) => t.name);
    assert.ok(names.includes("browser_propose_action"), "browser_propose_action tool missing");
    assert.ok(names.includes("browser_approve_action"), "browser_approve_action tool missing");
    for (const t of tools) {
      assert.equal(t.inputSchema.type, "object", `${t.name} inputSchema.type`);
      assert.ok("properties" in t.inputSchema, `${t.name} inputSchema.properties`);
    }
  });

  it("rejects malformed target-bearing calls through real MCP dispatch before handlers run (#4)", async () => {
    const invalidCalls: Array<{ name: string; args: unknown; label: string }> = [
      { name: "browser_click", args: {}, label: "click missing target" },
      {
        name: "browser_click",
        args: { ref: "p1s1_r1", selector: "#go" },
        label: "click conflicting targets",
      },
      { name: "browser_click", args: { x: 10 }, label: "click partial coordinates" },
      {
        name: "browser_type",
        args: { text: "hello", ref: "p1s1_r1", selector: "#name" },
        label: "type conflicting explicit targets",
      },
      { name: "browser_fill", args: { value: "Ada" }, label: "fill missing target" },
      {
        name: "browser_fill",
        args: { ref: "p1s1_r1", selector: "#name", value: "Ada" },
        label: "fill conflicting targets",
      },
      { name: "browser_hover", args: {}, label: "hover missing target" },
      {
        name: "browser_hover",
        args: { ref: "p1s1_r1", selector: "#menu" },
        label: "hover conflicting targets",
      },
      {
        name: "browser_drag",
        args: { fromRef: "p1s1_r1", fromSelector: "#drag", toSelector: "#drop" },
        label: "drag conflicting source targets",
      },
      {
        name: "browser_drag",
        args: { fromSelector: "#drag", toRef: "p1s1_r2", toSelector: "#drop" },
        label: "drag conflicting destination targets",
      },
      {
        name: "browser_drag",
        args: { fromSelector: "#drag" },
        label: "drag missing destination",
      },
      {
        name: "browser_select",
        args: { selector: "#country" },
        label: "select missing option",
      },
      {
        name: "browser_select",
        args: { selector: "#country", value: "my", label: "Malaysia" },
        label: "select conflicting option modes",
      },
    ];

    for (const invalid of invalidCalls) {
      const result = await client.callTool(invalid.name, invalid.args);
      assert.equal(result.isError, true, `${invalid.label} should be rejected by service dispatch`);
      assert.match(result.text, /^Error:/, `${invalid.label} should return a structured validation error`);
    }
  });

  it("navigate -> snapshot -> click-via-ref -> evaluate on the same page (#1, #2)", async () => {
    // A data: URL keeps the test hermetic — no network access needed.
    const nav = await client.callTool("browser_navigate", {
      url: "data:text/html,<button id='b' onclick='this.textContent=\"done\"'>Go</button><div id=r>no</div>",
    });
    assert.equal(nav.isError, false);
    assert.match(nav.text, /"ok":true/);

    // Snapshot on the SAME session must see the page navigated to above.
    const snap = await client.callTool("browser_snapshot", {});
    assert.equal(snap.isError, false);
    const snapBody = JSON.parse(snap.text) as { snapshot: string; refs: number };
    assert.ok(snapBody.refs >= 2, "snapshot should register at least 2 refs");

    const m = snapBody.snapshot.match(/- button "Go" \[ref=(\w+)\]/);
    assert.ok(m, `button ref not found in snapshot:\n${snapBody.snapshot}`);

    // Click via the snapshot ref — the core acceptance criterion of #2.
    const click = await client.callTool("browser_click", { ref: m[1] });
    assert.equal(click.isError, false);

    // Prove the click landed on the SAME page: evaluate reads DOM mutated by
    // the click handler. If session state were not persisted (#1), the page
    // would have been recreated and the button would still read "Go".
    const ev = await client.callTool("browser_evaluate", {
      expression: "document.getElementById('b').textContent",
    });
    assert.equal(ev.isError, false);
    const parsed = JSON.parse(ev.text) as { result: string };
    assert.equal(parsed.result, "done");
  });

  it("stale/unknown refs produce a structured error, not a crash (#2)", async () => {
    const res = await client.callTool("browser_click", { ref: "e999" });
    assert.equal(res.isError, true);
    assert.match(res.text, /no longer valid/);
  });

  it("console diagnostics are captured per session (#3)", async () => {
    await client.callTool("browser_navigate", {
      url: "data:text/html,<script>console.log('hello-from-e2e')</script>",
    });
    // Console delivery is async — give the page a beat to emit.
    await client.callTool("browser_wait", { time: 0.5 });
    const res = await client.callTool("browser_console", { level: "log" });
    assert.equal(res.isError, false);
    const body = JSON.parse(res.text) as { messages: Array<{ text: string }> };
    assert.ok(
      body.messages.some((msg) => msg.text.includes("hello-from-e2e")),
      "console buffer should contain the page's console.log",
    );
  });

  it("mixed ref/selector drag targets execute instead of silently succeeding (#4)", async () => {
    const html = `
      <button id="source" draggable="true">Drag</button>
      <button id="drop">Drop</button>
      <script>
        const source = document.getElementById('source');
        const drop = document.getElementById('drop');
        source.addEventListener('dragstart', (event) => event.dataTransfer.setData('text/plain', 'payload'));
        drop.addEventListener('dragover', (event) => event.preventDefault());
        drop.addEventListener('drop', (event) => {
          event.preventDefault();
          document.body.dataset.dropped = 'yes';
        });
      </script>
    `;
    const nav = await client.callTool("browser_navigate", {
      url: `data:text/html,${encodeURIComponent(html)}`,
    });
    assert.equal(nav.isError, false);

    const snap = await client.callTool("browser_snapshot", {});
    const snapBody = JSON.parse(snap.text) as { snapshot: string };
    const sourceMatch = snapBody.snapshot.match(/- button "Drag" \[ref=(\w+)\]/);
    const dropMatch = snapBody.snapshot.match(/- button "Drop" \[ref=(\w+)\]/);
    assert.ok(sourceMatch, `source ref not found in snapshot:\n${snapBody.snapshot}`);
    assert.ok(dropMatch, `drop ref not found in snapshot:\n${snapBody.snapshot}`);

    const refToSelector = await client.callTool("browser_drag", {
      fromRef: sourceMatch[1],
      toSelector: "#drop",
    });
    assert.equal(refToSelector.isError, false);
    const firstState = await client.callTool("browser_evaluate", {
      expression: "document.body.dataset.dropped ?? null",
    });
    assert.equal((JSON.parse(firstState.text) as { result: string | null }).result, "yes");

    await client.callTool("browser_evaluate", {
      expression: "delete document.body.dataset.dropped",
    });
    const selectorToRef = await client.callTool("browser_drag", {
      fromSelector: "#source",
      toRef: dropMatch[1],
    });
    assert.equal(selectorToRef.isError, false);
    const secondState = await client.callTool("browser_evaluate", {
      expression: "document.body.dataset.dropped ?? null",
    });
    assert.equal((JSON.parse(secondState.text) as { result: string | null }).result, "yes");
  });
});
