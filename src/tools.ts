import { z } from "zod";
import type { Page } from "playwright";
import type { BrowserManager } from "./browser.js";

export interface ToolContext {
  manager: BrowserManager;
}

export interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  handler: (args: unknown, ctx: ToolContext) => Promise<unknown>;
}

async function page(ctx: ToolContext) {
  return ctx.manager.page();
}

export const navigate: ToolDef = {
  name: "browser_navigate",
  description: "Open a URL in the browser.",
  schema: z.object({ url: z.string().url() }),
  handler: async (args, ctx) => {
    const { url } = args as { url: string };
    const p = await page(ctx);
    await p.goto(url, { waitUntil: "domcontentloaded" });
    return { ok: true, url: p.url() };
  },
};

export const snapshot: ToolDef = {
  name: "browser_snapshot",
  description: "Return the accessibility tree for the current page.",
  schema: z.object({}).passthrough(),
  handler: async (_args, ctx) => {
    const p = await page(ctx);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const snap = await (p.accessibility as any).snapshot();
    return { snapshot: snap };
  },
};

export const clickTool: ToolDef = {
  name: "browser_click",
  description: "Click an element identified by ref (from snapshot), selector, or x,y coordinates.",
  schema: z.object({
    ref: z.string().optional(),
    selector: z.string().optional(),
    x: z.number().int().nonnegative().optional(),
    y: z.number().int().nonnegative().optional(),
  }).refine(v => v.ref || v.selector || (v.x !== undefined && v.y !== undefined), {
    message: "Provide one of: ref, selector, or x+y",
  }),
  handler: async (args, ctx) => {
    const { ref, selector, x, y } = args as { ref?: string; selector?: string; x?: number; y?: number };
    const p = await page(ctx);
    if (selector) {
      await p.click(selector);
    } else if (x !== undefined && y !== undefined) {
      await p.mouse.click(x, y);
    } else if (ref) {
      await p.click(`[aria-ref="${ref}"]`);
    }
    return { ok: true };
  },
};

export const typeTool: ToolDef = {
  name: "browser_type",
  description: "Type text into the focused or matched element.",
  schema: z.object({
    text: z.string(),
    selector: z.string().optional(),
    slowly: z.boolean().optional(),
    submit: z.boolean().optional(),
  }),
  handler: async (args, ctx) => {
    const { text, selector, slowly, submit } = args as { text: string; selector?: string; slowly?: boolean; submit?: boolean };
    const p = await page(ctx);
    if (selector) {
      await p.fill(selector, text);
    } else {
      await p.keyboard.type(text, slowly ? { delay: 50 } : undefined);
    }
    if (submit) await p.keyboard.press("Enter");
    return { ok: true };
  },
};

export const fill: ToolDef = {
  name: "browser_fill",
  description: "Replace an input value via the accessibility API (no key events).",
  schema: z.object({ selector: z.string(), value: z.string() }),
  handler: async (args, ctx) => {
    const { selector, value } = args as { selector: string; value: string };
    const p = await page(ctx);
    await p.fill(selector, value);
    return { ok: true };
  },
};

export const press: ToolDef = {
  name: "browser_press",
  description: "Press a non-text key (Enter, Tab, Escape, arrows, etc.).",
  schema: z.object({ key: z.string() }),
  handler: async (args, ctx) => {
    const { key } = args as { key: string };
    const p = await page(ctx);
    await p.keyboard.press(key);
    return { ok: true };
  },
};

export const hover: ToolDef = {
  name: "browser_hover",
  description: "Hover an element.",
  schema: z.object({ selector: z.string() }),
  handler: async (args, ctx) => {
    const { selector } = args as { selector: string };
    const p = await page(ctx);
    await p.hover(selector);
    return { ok: true };
  },
};

export const drag: ToolDef = {
  name: "browser_drag",
  description: "Drag from one element to another.",
  schema: z.object({ from: z.string(), to: z.string() }),
  handler: async (args, ctx) => {
    const { from, to } = args as { from: string; to: string };
    const p = await page(ctx);
    await p.dragAndDrop(from, to);
    return { ok: true };
  },
};

export const select: ToolDef = {
  name: "browser_select",
  description: "Select an <option> by value or label.",
  schema: z.object({ selector: z.string(), value: z.string().optional(), label: z.string().optional() }),
  handler: async (args, ctx) => {
    const { selector, value, label } = args as { selector: string; value?: string; label?: string };
    const p = await page(ctx);
    if (value) await p.selectOption(selector, value);
    else if (label) await p.selectOption(selector, { label });
    else throw new Error("Provide value or label");
    return { ok: true };
  },
};

export const screenshot: ToolDef = {
  name: "browser_screenshot",
  description: "Capture a PNG screenshot. Returns base64 or saves to disk if savePath is set.",
  schema: z.object({
    fullPage: z.boolean().optional(),
    savePath: z.string().optional(),
    element: z.string().optional(),
  }),
  handler: async (args, ctx) => {
    const { fullPage, savePath, element } = args as { fullPage?: boolean; savePath?: string; element?: string };
    const p = await page(ctx);
    let buf: Buffer;
    if (element) {
      const handle = await p.locator(element).first();
      buf = await handle.screenshot({ type: "png" });
    } else {
      buf = await p.screenshot({ fullPage: !!fullPage, type: "png" });
    }
    if (savePath) {
      const fs = await import("node:fs/promises");
      await fs.writeFile(savePath, buf);
      return { ok: true, savedTo: savePath };
    }
    return { ok: true, base64: buf.toString("base64") };
  },
};

export const evaluate: ToolDef = {
  name: "browser_evaluate",
  description: "Run a JS expression in the page context and return its JSON-serializable result.",
  schema: z.object({ expression: z.string() }),
  handler: async (args, ctx) => {
    const { expression } = args as { expression: string };
    const p = await page(ctx);
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const fn = new Function(`"use strict"; return (${expression});`);
    const result = await p.evaluate(fn as never);
    return { result };
  },
};

export const wait: ToolDef = {
  name: "browser_wait",
  description: "Wait for a selector/text or a fixed duration.",
  schema: z.object({
    time: z.number().nonnegative().optional(),
    text: z.string().optional(),
    textGone: z.string().optional(),
    selector: z.string().optional(),
  }),
  handler: async (args, ctx) => {
    const { time, text, textGone, selector } = args as { time?: number; text?: string; textGone?: string; selector?: string };
    const p = await page(ctx);
    if (time !== undefined && !text && !textGone && !selector) {
      await p.waitForTimeout(time * 1000);
    } else {
      if (selector) await p.waitForSelector(selector);
      if (text) await p.getByText(text).first().waitFor();
      if (textGone) await p.getByText(textGone).first().waitFor({ state: "hidden" });
    }
    return { ok: true };
  },
};

export const consoleTool: ToolDef = {
  name: "browser_console",
  description: "Subscribe to / read console messages from the page.",
  schema: z.object({
    level: z.enum(["log", "info", "warn", "error", "debug"]).default("log"),
    limit: z.number().int().positive().max(500).default(100),
  }),
  handler: async (args, ctx) => {
    const { level, limit } = args as { level: "log" | "info" | "warn" | "error" | "debug"; limit: number };
    const p = pageForConsole(ctx);
    const filtered = consoleBuffer.filter(m => levelCompare(m.level, level)).slice(-limit);
    return { messages: filtered };
  },
};

export const network: ToolDef = {
  name: "browser_network",
  description: "List captured network requests since the page loaded.",
  schema: z.object({ static: z.boolean().default(false) }),
  handler: async (args, ctx) => {
    const { static: includeStatic } = args as { static: boolean };
    const p = pageForConsole(ctx);
    return {
      requests: networkBuffer.filter(r => includeStatic || r.type !== "static").slice(-200),
    };
  },
};

export const captchaSolve: ToolDef = {
  name: "browser_captcha_solve",
  description: "Forward a captcha challenge to the configured solver (PILOT_CAPTCHA_SOLVER_URL).",
  schema: z.object({
    siteKey: z.string(),
    pageUrl: z.string().url(),
    type: z.enum(["recaptcha-v2", "recaptcha-v3", "hcaptcha", "turnstile"]).default("recaptcha-v2"),
  }),
  handler: async (args, ctx) => {
    const { siteKey, pageUrl, type } = args as { siteKey: string; pageUrl: string; type: string };
    const cfg = (ctx as unknown as { solver?: { url?: string; token?: string } }).solver;
    if (!cfg?.url || !cfg?.token) {
      throw new Error("Captcha solver not configured. Set PILOT_CAPTCHA_SOLVER_URL and PILOT_CAPTCHA_SOLVER_TOKEN.");
    }
    const res = await fetch(cfg.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify({ siteKey, pageUrl, type }),
    });
    if (!res.ok) throw new Error(`Solver returned ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { token?: string };
    if (!data.token) throw new Error("Solver did not return a token");
    return { token: data.token };
  },
};

// --- internal helpers for console/network buffering ------------------------------------

const consoleBuffer: Array<{ level: string; text: string; at: number }> = [];
const networkBuffer: Array<{ url: string; method: string; status: number; type: string }> = [];
const hooked = new WeakSet<Page>();

function pageForConsole(ctx: ToolContext): Page {
  // We rely on ctx.manager.page() having already wired the listeners.
  // The buffer is module-level and shared across calls.
  return null as unknown as Page;
}

function levelCompare(actual: string, min: "log" | "info" | "warn" | "error" | "debug"): boolean {
  const order = ["debug", "log", "info", "warn", "error"];
  return order.indexOf(actual) >= order.indexOf(min);
}

export async function installBuffers(p: Page): Promise<void> {
  if (hooked.has(p)) return;
  hooked.add(p);
  p.on("console", (msg) => consoleBuffer.push({ level: msg.type(), text: msg.text(), at: Date.now() }));
  p.on("requestfinished", async (req) => {
    const res = await req.response();
    networkBuffer.push({ url: req.url(), method: req.method(), status: res?.status() ?? 0, type: req.resourceType() });
  });
  p.on("requestfailed", (req) => {
    networkBuffer.push({ url: req.url(), method: req.method(), status: 0, type: req.resourceType() });
  });
}

export const allTools: ToolDef[] = [
  navigate,
  snapshot,
  clickTool,
  typeTool,
  fill,
  press,
  hover,
  drag,
  select,
  screenshot,
  evaluate,
  wait,
  consoleTool,
  network,
  captchaSolve,
];
