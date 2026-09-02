import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const cliPath = process.argv[2];
if (!cliPath) throw new Error("usage: node test/package-smoke.mjs /path/to/installed/dist/cli.js");

const proc = spawn(process.execPath, [cliPath], { stdio: ["pipe", "pipe", "pipe"] });
let buffer = "";
let nextId = 1;
const pending = new Map();

proc.stdout.on("data", chunk => {
  buffer += chunk.toString();
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  }
});

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for ${method}`));
    }, 30_000);
    pending.set(id, response => {
      clearTimeout(timer);
      resolve(response);
    });
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

function notify(method) {
  proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
}

async function callTool(name, args) {
  const response = await rpc("tools/call", { name, arguments: args });
  assert.equal(response.result?.isError, undefined, `${name} returned MCP error: ${JSON.stringify(response)}`);
  const text = response.result?.content?.[0]?.text;
  assert.equal(typeof text, "string", `${name} did not return text content`);
  return JSON.parse(text);
}

try {
  const init = await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "packed-package-smoke", version: "0.0.0" },
  });
  assert.equal(init.result?.serverInfo?.name, "orchords-web-pilot");
  notify("notifications/initialized");

  await callTool("browser_navigate", {
    url: "data:text/html,<button onclick='this.textContent=\"packed-ok\"'>Packed</button>",
  });
  const snapshot = await callTool("browser_snapshot", {});
  const match = snapshot.snapshot.match(/button \"Packed\" \[ref=([^\]]+)\]/);
  assert.ok(match, `snapshot did not expose Packed button ref:\n${snapshot.snapshot}`);
  await callTool("browser_click", { ref: match[1] });
  const result = await callTool("browser_evaluate", { expression: "document.querySelector('button').textContent" });
  assert.equal(result.result, "packed-ok");
  console.log("packed package smoke passed");
} finally {
  proc.kill("SIGTERM");
}
