import { z } from "zod";
import type { Session } from "./session.js";
import { resolveRef } from "./refs.js";

export interface ToolContext {
  session: Session;
}

export interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  handler: (args: unknown, ctx: ToolContext) => Promise<unknown>;
}

/** Solver config forwarded from server.ts into the captcha tool. */
export interface SolverConfig {
  solver?: { url?: string; token?: string };
}

async function page(ctx: ToolContext) {
  return ctx.session.page();
}

export const navigate: ToolDef = {
  name: "browser_navigate",
  description: "Open a URL in the browser.",
  schema: z.object({ url: z.string().url() }),
  handler: async (args, ctx) => {
    const { url } = args as { url: string };
    const p = await page(ctx);
    await p.goto(url, { waitUntil: "domcontentloaded" });
    ctx.session.clearRefs();
    return { ok: true, url: p.url() };
  },
};

export const snapshot: ToolDef = {
  name: "browser_snapshot",
  description:
    "Return the AI-oriented accessibility snapshot for the current page. Each node carries a generation-bound `ref` token (e.g. `[ref=p2s3_r7]`) that can be passed back into browser_click/browser_type/etc. Refs are invalidated by navigation, rerendered/recycled target nodes, or a newer snapshot.",
  schema: z.object({}).passthrough(),
  handler: async (_args, ctx) => {
    const p = await page(ctx);
    const pageGeneration = ctx.session.pageGeneration();
    const yamlText = await p.ariaSnapshot({ mode: "ai" });
    if (ctx.session.pageGeneration() !== pageGeneration) {
      throw new Error("Page changed while browser_snapshot was being captured. Take a fresh snapshot.");
    }

    const result = ctx.session.refs.ingest(yamlText, p, pageGeneration);
    await ctx.session.refs.bindHandles(p, result.snapshotGeneration);
    if (ctx.session.pageGeneration() !== pageGeneration) {
      ctx.session.clearRefs();
      throw new Error("Page changed while browser_snapshot refs were being bound. Take a fresh snapshot.");
    }

    ctx.session.noteSnapshotTaken();
    return {
      snapshot: result.snapshot,
      refs: result.registered,
      pageGeneration,
      snapshotGeneration: result.snapshotGeneration,
    };
  },
};

export const clickTool: ToolDef = {
  name: "browser_click",
  description:
    "Click an element identified by a snapshot ref, CSS selector, or x+y coordinates. Prefer `ref` from browser_snapshot.",
  schema: z
    .object({
      ref: z.string().optional(),
      selector: z.string().optional(),
      x: z.number().int().nonnegative().optional(),
      y: z.number().int().nonnegative().optional(),
    })
    .refine((v) => {
      const hasRef = Boolean(v.ref);
      const hasSelector = Boolean(v.selector);
      const hasAnyCoordinate = v.x !== undefined || v.y !== undefined;
      const hasCompleteCoordinates = v.x !== undefined && v.y !== undefined;
      const modes = Number(hasRef) + Number(hasSelector) + Number(hasAnyCoordinate);
      return modes === 1 && (!hasAnyCoordinate || hasCompleteCoordinates);
    }, {
      message: "Provide exactly one of ref, selector, or complete x+y",
    }),
  handler: async (args, ctx) => {
    const { ref, selector, x, y } = args as { ref?: string; selector?: string; x?: number; y?: number };
    const p = await page(ctx);
    if (ref) {
      const loc = resolveRef(p, ctx.session.refs, ref);
      await loc.click();
    } else if (selector) {
      await p.click(selector);
    } else if (x !== undefined && y !== undefined) {
      await p.mouse.click(x, y);
    }
    return { ok: true };
  },
};

export const typeTool: ToolDef = {
  name: "browser_type",
  description: "Type text into the focused, matched, or ref-targeted element using keyboard events.",
  schema: z.object({
    text: z.string(),
    ref: z.string().optional(),
    selector: z.string().optional(),
    slowly: z.boolean().optional(),
    submit: z.boolean().optional(),
  }),
  handler: async (args, ctx) => {
    const { text, ref, selector, slowly, submit } = args as {
      text: string;
      ref?: string;
      selector?: string;
      slowly?: boolean;
      submit?: boolean;
    };
    const p = await page(ctx);
    const typingOptions = slowly ? { delay: 50 } : undefined;
    if (ref) {
      const loc = resolveRef(p, ctx.session.refs, ref);
      await loc.pressSequentially(text, typingOptions);
    } else if (selector) {
      await p.locator(selector).pressSequentially(text, typingOptions);
    } else {
      await p.keyboard.type(text, typingOptions);
    }
    if (submit) await p.keyboard.press("Enter");
    return { ok: true };
  },
};

export const fill: ToolDef = {
  name: "browser_fill",
  description: "Replace an input value via Playwright's fill() — accepts a selector or a snapshot ref.",
  schema: z
    .object({ ref: z.string().optional(), selector: z.string().optional(), value: z.string() })
    .refine((v) => Boolean(v.ref) !== Boolean(v.selector), { message: "Provide exactly one of ref or selector" }),
  handler: async (args, ctx) => {
    const { ref, selector, value } = args as { ref?: string; selector?: string; value: string };
    const p = await page(ctx);
    if (ref) {
      const loc = resolveRef(p, ctx.session.refs, ref);
      await loc.fill(value);
    } else if (selector) {
      await p.fill(selector, value);
    }
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
  description: "Hover an element. Accepts a snapshot ref or a selector.",
  schema: z
    .object({ ref: z.string().optional(), selector: z.string().optional() })
    .refine((v) => Boolean(v.ref) !== Boolean(v.selector), { message: "Provide exactly one of ref or selector" }),
  handler: async (args, ctx) => {
    const { ref, selector } = args as { ref?: string; selector?: string };
    const p = await page(ctx);
    if (ref) {
      const loc = resolveRef(p, ctx.session.refs, ref);
      await loc.hover();
    } else if (selector) {
      await p.hover(selector);
    }
    return { ok: true };
  },
};

export const drag: ToolDef = {
  name: "browser_drag",
  description: "Drag from one element to another. Accepts snapshot refs or selectors.",
  schema: z
    .object({
      fromRef: z.string().optional(),
      fromSelector: z.string().optional(),
      toRef: z.string().optional(),
      toSelector: z.string().optional(),
    })
    .refine((v) => (v.fromRef || v.fromSelector) && (v.toRef || v.toSelector), {
      message: "Provide fromRef/fromSelector AND toRef/toSelector",
    }),
  handler: async (args, ctx) => {
    const { fromRef, fromSelector, toRef, toSelector } = args as {
      fromRef?: string;
      fromSelector?: string;
      toRef?: string;
      toSelector?: string;
    };
    const p = await page(ctx);

    const hoverSource = async () => {
      if (fromRef) await resolveRef(p, ctx.session.refs, fromRef).hover();
      else await p.locator(fromSelector!).hover();
    };
    const hoverTarget = async () => {
      if (toRef) await resolveRef(p, ctx.session.refs, toRef).hover();
      else await p.locator(toSelector!).hover();
    };

    // Playwright's documented manual drag sequence works across target
    // representations. Repeat the destination hover so pages that depend on
    // dragover receive the second mouse move consistently in all browsers.
    await hoverSource();
    await p.mouse.down();
    try {
      await hoverTarget();
      await hoverTarget();
    } finally {
      await p.mouse.up();
    }
    return { ok: true };
  },
};

export const select: ToolDef = {
  name: "browser_select",
  description: "Select an <option> by value or label. Accepts a snapshot ref or a selector.",
  schema: z
    .object({
      ref: z.string().optional(),
      selector: z.string().optional(),
      value: z.string().optional(),
      label: z.string().optional(),
    })
    .refine((v) => Boolean(v.ref) !== Boolean(v.selector), { message: "Provide exactly one of ref or selector" })
    .refine((v) => Boolean(v.value) !== Boolean(v.label), { message: "Provide exactly one of value or label" }),
  handler: async (args, ctx) => {
    const { ref, selector, value, label } = args as {
      ref?: string;
      selector?: string;
      value?: string;
      label?: string;
    };
    const p = await page(ctx);
    const option = value ? value : { label: label! };
    if (ref) await resolveRef(p, ctx.session.refs, ref).selectOption(option);
    else await p.locator(selector!).selectOption(option);
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
    const { fullPage, savePath, element } = args as {
      fullPage?: boolean;
      savePath?: string;
      element?: string;
    };
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
    const { time, text, textGone, selector } = args as {
      time?: number;
      text?: string;
      textGone?: string;
      selector?: string;
    };
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
  description: "Read console messages captured for the current session.",
  schema: z.object({
    level: z.enum(["log", "info", "warn", "error", "debug"]).default("log"),
    limit: z.number().int().positive().max(500).default(100),
  }),
  handler: async (args, ctx) => {
    const { level, limit } = args as { level: "log" | "info" | "warn" | "error" | "debug"; limit: number };
    return { messages: ctx.session.diagnostics.console(level, limit) };
  },
};

export const network: ToolDef = {
  name: "browser_network",
  description: "List network requests captured for the current session.",
  schema: z.object({
    static: z.boolean().default(false),
    limit: z.number().int().positive().max(500).default(200),
  }),
  handler: async (args, ctx) => {
    const { static: includeStatic, limit } = args as { static: boolean; limit: number };
    return { requests: ctx.session.diagnostics.network(includeStatic, limit) };
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
    const cfg = (ctx as unknown as SolverConfig).solver;
    if (!cfg?.url || !cfg?.token) {
      throw new Error(
        "Captcha solver not configured. Set PILOT_CAPTCHA_SOLVER_URL and PILOT_CAPTCHA_SOLVER_TOKEN.",
      );
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
