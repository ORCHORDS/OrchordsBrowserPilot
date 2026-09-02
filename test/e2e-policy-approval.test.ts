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
  error?: { code: number; message: string };
}

interface ToolResult {
  text: string;
  isError: boolean;
}

interface Proposal {
  proposalId: string;
  envelopeDigest: string;
  requiresApproval: boolean;
  riskClass: string;
}

interface Approval {
  ok: boolean;
  approvalId: string;
}

const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/cli.js");

class McpClient {
  private readonly proc: ChildProcess;
  private buf = "";
  private nextId = 1;
  private readonly pending = new Map<number, (response: JsonRpcResponse) => void>();

  constructor() {
    this.proc = spawn(process.execPath, [cliPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PILOT_POLICY_MODE: "enforce" },
    });
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
        // Ignore non-JSON child output.
      }
    }
  }

  send(method: string, params?: unknown): { id: number; response: Promise<JsonRpcResponse> } {
    const id = this.nextId++;
    const response = new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, 45_000);
      this.pending.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return { id, response };
  }

  notify(method: string, params?: unknown): void {
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async callTool(name: string, args: unknown): Promise<ToolResult> {
    const { response } = this.send("tools/call", { name, arguments: args });
    const rpc = await response;
    assert.equal(rpc.error, undefined, JSON.stringify(rpc));
    return {
      text: rpc.result?.content?.[0]?.text ?? "",
      isError: rpc.result?.isError === true,
    };
  }

  kill(): void {
    this.proc.kill();
  }
}

function parseJson<T>(result: ToolResult): T {
  assert.notEqual(result.text, "", "expected JSON tool result");
  return JSON.parse(result.text) as T;
}

describe("E2E policy approvals + queued TOCTOU (#81/#104)", () => {
  let client: McpClient;

  before(async () => {
    client = new McpClient();
    const { response } = client.send("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "e2e-policy-approval", version: "0.0.0" },
    });
    const init = await response;
    assert.equal(init.error, undefined, JSON.stringify(init));
    assert.equal(init.result?.serverInfo?.name, "orchords-web-pilot");
    client.notify("notifications/initialized");
  });

  after(() => client.kill());

  async function propose(tool: string, args: Record<string, unknown>): Promise<Proposal> {
    const result = await client.callTool("browser_propose_action", { tool, arguments: args });
    assert.equal(result.isError, false, result.text);
    const proposal = parseJson<Proposal>(result);
    assert.match(proposal.proposalId, /^[0-9a-f-]{36}$/i);
    assert.match(proposal.envelopeDigest, /^[a-f0-9]{64}$/);
    return proposal;
  }

  async function approve(proposal: Proposal): Promise<Approval> {
    const result = await client.callTool("browser_approve_action", {
      envelopeDigest: proposal.envelopeDigest,
      approverId: "e2e-human",
      decision: "approve",
    });
    assert.equal(result.isError, false, result.text);
    const approval = parseJson<Approval>(result);
    assert.equal(approval.ok, true, result.text);
    assert.ok(approval.approvalId);
    return approval;
  }

  async function dispatchApproved(
    tool: string,
    args: Record<string, unknown>,
    proposal: Proposal,
    approval: Approval,
  ): Promise<ToolResult> {
    return client.callTool(tool, {
      ...args,
      _proposalId: proposal.proposalId,
      _approval: approval.approvalId,
    });
  }

  it("permits an unchanged approved sensitive action through the real enforce-mode transport", async () => {
    const args = { expression: "1 + 1" };
    const proposal = await propose("browser_evaluate", args);
    assert.equal(proposal.requiresApproval, true);
    assert.equal(proposal.riskClass, "sensitive");
    const approval = await approve(proposal);

    const dispatched = await dispatchApproved("browser_evaluate", args, proposal, approval);
    assert.equal(dispatched.isError, false, dispatched.text);
    assert.equal(parseJson<{ result: number }>(dispatched).result, 2);
  });

  it("invalidates an approved action when live page state drifts while it waits in the session queue", async () => {
    // Use a normal about:blank document for the drift fixture. `data:` URLs
    // are opaque/nonstandard top-level URLs and are a poor same-document
    // navigation fixture. A fragment update on about:blank is an ordinary
    // same-document URL change that Playwright reports through frame
    // navigation state.
    const navigated = await client.callTool("browser_navigate", { url: "about:blank" });
    assert.equal(navigated.isError, false, navigated.text);

    const targetArgs = {
      expression: "(() => { globalThis.__shouldNotRun = true; return 42; })()",
    };
    const targetProposal = await propose("browser_evaluate", targetArgs);
    const targetApproval = await approve(targetProposal);

    const scheduleArgs = {
      expression: "(() => { setTimeout(() => { location.hash = 'changed'; }, 200); return 'scheduled'; })()",
    };
    const scheduleProposal = await propose("browser_evaluate", scheduleArgs);
    const scheduleApproval = await approve(scheduleProposal);
    const scheduled = await dispatchApproved(
      "browser_evaluate",
      scheduleArgs,
      scheduleProposal,
      scheduleApproval,
    );
    assert.equal(scheduled.isError, false, scheduled.text);

    // Occupy the single session slot with a read-only wait. The already-
    // approved target is submitted while that wait owns the slot, so the
    // page-side timer changes the URL after approval but before target gate.
    const waitCall = client.send("tools/call", {
      name: "browser_wait",
      arguments: { time: 0.6 },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const targetCall = client.send("tools/call", {
      name: "browser_evaluate",
      arguments: {
        ...targetArgs,
        _proposalId: targetProposal.proposalId,
        _approval: targetApproval.approvalId,
      },
    });

    const [waitRpc, targetRpc] = await Promise.all([waitCall.response, targetCall.response]);
    assert.equal(waitRpc.error, undefined, JSON.stringify(waitRpc));
    assert.notEqual(waitRpc.result?.isError, true, JSON.stringify(waitRpc));
    assert.equal(targetRpc.error, undefined, JSON.stringify(targetRpc));
    assert.equal(targetRpc.result?.isError, true, JSON.stringify(targetRpc));
    const blockedText = targetRpc.result?.content?.[0]?.text ?? "";
    const blocked = JSON.parse(blockedText) as { blocked: boolean; reason: string };
    assert.equal(blocked.blocked, true);
    assert.equal(blocked.reason, "envelope_changed");

    // Prove both sides of the race: the page state really did drift, and the
    // delayed sensitive expression did not execute. This check is freshly
    // proposed/approved against the post-drift state.
    const checkArgs = {
      expression: "({ hash: location.hash, ran: Boolean(globalThis.__shouldNotRun) })",
    };
    const checkProposal = await propose("browser_evaluate", checkArgs);
    const checkApproval = await approve(checkProposal);
    const checked = await dispatchApproved("browser_evaluate", checkArgs, checkProposal, checkApproval);
    assert.equal(checked.isError, false, checked.text);
    assert.deepEqual(
      parseJson<{ result: { hash: string; ran: boolean } }>(checked).result,
      { hash: "#changed", ran: false },
    );
  });
});
