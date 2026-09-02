import type { Frame, Locator, Page } from "playwright";
import yaml from "yaml";

/**
 * A single accessibility ref emitted by `Page.ariaSnapshot({ mode: "ai" })`.
 *
 * The YAML uses `[ref=eNN]` (or `[ref=ref/NN]`) after each role. We key the
 * registry by that exact string so the value emitted in `browser_snapshot`
 * output can be passed back into the action tools unchanged.
 */
export interface RefEntry {
  ref: string;
  role: string;
  name: string;
  /** URL of the frame that owns this element, "" for the main frame. */
  frameUrl: string;
  /** Index among elements with the same (role, name) tuple — disambiguates repeats. */
  index: number;
}

/**
 * Tracks refs from the most recent snapshot for the current session. Cleared
 * automatically when the page navigates (caller's responsibility to call
 * `clear()`) or when a new snapshot supersedes it.
 */
export class RefRegistry {
  private readonly entries = new Map<string, RefEntry>();
  private readonly seenKeys = new Map<string, number>();

  /** Erase all tracked refs (call before each new snapshot). */
  clear(): void {
    this.entries.clear();
    this.seenKeys.clear();
  }

  /**
   * Parse a Playwright `ariaSnapshot({mode:"ai"})` YAML output and record
   * every node that contains `[ref=...]`.
   *
   * Returns the list of refs that were registered. Duplicates within the
   * same snapshot keep their numeric suffix but the registry keeps only the
   * last occurrence under the bare key — disambiguation uses the `index`
   * counter when callers resolve `ref=foo` against multiple matches.
   */
  ingest(snapshotYaml: string, _page: Page): { registered: number } {
    this.clear();
    const nodes = parseAiSnapshot(snapshotYaml);
    const frameIndex = new Map<string, number>();
    for (const node of nodes) {
      const key = node.role + "\u0001" + node.name;
      const nth = frameIndex.get(node.frameUrl + "\u0001" + key) ?? 0;
      frameIndex.set(node.frameUrl + "\u0001" + key, nth + 1);
      node.index = nth;
      this.entries.set(node.ref, node);
    }
    return { registered: nodes.length };
  }

  /**
   * Look up a ref by its emitted key. Returns null when the ref has never
   * been registered for this session — the caller should raise a structured
   * stale-ref error.
   */
  get(ref: string): RefEntry | null {
    return this.entries.get(ref) ?? null;
  }

  /** Number of currently-tracked refs (mainly for diagnostics/tests). */
  size(): number {
    return this.entries.size;
  }
}

/** Custom error so callers can distinguish a stale ref from other failures. */
export class StaleRefError extends Error {
  constructor(public readonly ref: string) {
    super(`Ref '${ref}' is no longer valid. Take a new browser_snapshot and try again.`);
    this.name = "StaleRefError";
  }
}

/**
 * Resolve a registered ref to a Playwright Locator scoped to the frame that
 * owns the element. Throws StaleRefError if the ref is unknown.
 */
export function resolveRef(page: Page, registry: RefRegistry, ref: string): Locator {
  const entry = registry.get(ref);
  if (!entry) throw new StaleRefError(ref);
  const frame = frameForUrl(page, entry.frameUrl) ?? page.mainFrame();
  const loc = frame.getByRole(entry.role as never, { name: entry.name, exact: false });
  return entry.index > 0 ? loc.nth(entry.index) : loc;
}

function frameForUrl(page: Page, url: string): Frame | null {
  if (!url) return null;
  for (const f of page.frames()) {
    if (f.url() === url) return f;
  }
  return null;
}

/**
 * Walk the `ariaSnapshot({mode:"ai"})` YAML and pull out every node that has
 * a `[ref=...]` marker. Playwright uses two shapes:
 *
 *   - generic: `- text "Save" [ref=e23]`
 *   - nested under `iframes:`:
 *       iframes:
 *         - ref=iframe1
 *           content: |
 *             - text "OK" [ref=e24]
 *
 * We only need (role, name, ref, frameUrl) — selectors are reconstructed at
 * resolve time via `getByRole`, which already handles the role+name tuple.
 */
function parseAiSnapshot(yamlText: string): Array<RefEntry & { index: number }> {
  const out: Array<RefEntry & { index: number }> = [];
  if (!yamlText.trim()) return out;

  // The AI-mode snapshot is a YAML document whose root is either an array
  // of nodes (typical) or a map keyed by ref (some modes). We walk every
  // string scalar in the tree and pull out the `[ref=eN]` token plus the
  // role and accessible name that precede it. Two real shapes:
  //
  //   - generic [ref=e1]:
  //       - heading "Settings" [level=1] [ref=e2]
  //       - listitem [ref=e6]: Item
  //       - button "Save" [ref=e3]
  //
  // The third shape is `<role> "<name>"` and the fourth is `<role>: <text>`
  // (the latter only used when no accessible name is available — we treat
  // the inline text as the name so getByRole() can still resolve it).
  const doc = yaml.parse(yamlText) as unknown;
  walk(doc, "", out);
  return out;
}

function walk(node: unknown, frameUrl: string, out: Array<RefEntry & { index: number }>): void {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, frameUrl, out);
    return;
  }
  if (typeof node !== "object") {
    extractRefFromScalar(String(node), frameUrl, out);
    return;
  }
  const obj = node as Record<string, unknown>;
  // iframes are scoped to their own frame — recurse with the iframe's own
  // ref as the frameUrl so nested refs resolve to the iframe frame later.
  if (Array.isArray(obj.iframes)) {
    for (const f of obj.iframes) walk(f, frameUrl, out);
  }
  for (const [key, value] of Object.entries(obj)) {
    if (key === "iframes") continue;
    if (typeof value === "string") {
      // When yaml parses `- listitem [ref=e6]: Item`, the key carries the
      // ref + role but no name; the name lives in the value scalar. Pass
      // the value in as a "name hint" so extractRefFromScalar can fold it
      // in when the key has no quoted name.
      extractRefFromScalar(key, frameUrl, out, value);
      extractRefFromScalar(value, frameUrl, out);
    } else {
      walk(value, frameUrl, out);
    }
  }
}

function extractRefFromScalar(
  scalar: string,
  frameUrl: string,
  out: Array<RefEntry & { index: number }>,
  nameHint?: string,
): void {
  const refMatch = scalar.match(/\[ref=([^\]]+)\]/);
  if (!refMatch) return;
  // Strip trailing attribute lists (`[level=1]`, `[active]`, …) and the
  // `[ref=...]` token itself; the remainder is the role + optional
  // `"name"` (or trailing `: text`).
  const beforeRef = scalar.slice(0, refMatch.index).trim();
  const head = beforeRef.replace(/\[[^\]]*\]\s*$/, "").trim();
  const roleName = head.match(/^([\w-]+)\s*(?:"([^"]*)"|'([^']*)')?\s*(?::\s*(.*))?$/);
  if (!roleName) return;
  const role = roleName[1]!;
  let name = roleName[2] ?? roleName[3] ?? (roleName[4] ?? "").trim();
  // Key shape `- listitem [ref=e6]: Item` collapses to key="- listitem [ref=e6]"
  // and value="Item" — the colon-text part of the regex above captures an
  // empty string because the colon is AFTER the ref. Use the hint instead.
  if (!name && nameHint && !nameHint.includes("[ref=")) {
    name = nameHint.trim();
  }
  out.push({ ref: refMatch[1]!, role, name, frameUrl, index: 0 });
}