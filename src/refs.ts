import { createHash } from "node:crypto";
import type { ElementHandle, Page } from "playwright";
import yaml from "yaml";

type PinnedElement = ElementHandle<SVGElement | HTMLElement>;

/**
 * A single accessibility ref emitted by `Page.ariaSnapshot({ mode: "ai" })`.
 *
 * Production refs are re-keyed with a page/snapshot generation token before
 * they leave the server. The raw Playwright ref remains internal so a token
 * from a superseded snapshot can never silently resolve to a newer element.
 */
export interface RefEntry {
  ref: string;
  sourceRef: string;
  role: string;
  name: string;
  /** URL of the frame that owns this element, "" for the main frame. */
  frameUrl: string;
  /** Index among elements with the same (role, name) tuple — disambiguates repeats. */
  index: number;
  pageGeneration: number;
  snapshotGeneration: number;
  handle?: PinnedElement;
  fingerprint?: string;
}

export interface RefIngestResult {
  registered: number;
  snapshot: string;
  snapshotGeneration: number;
}

/**
 * Tracks refs from the most recent snapshot for the current session.
 *
 * Two safety properties are intentional here:
 * 1. every production snapshot emits generation-qualified ref tokens, so a
 *    token from an older snapshot cannot alias a ref from a newer snapshot;
 * 2. each ref is pinned to the exact ElementHandle captured from that
 *    snapshot. Playwright locators deliberately re-resolve against the latest
 *    DOM; snapshot refs must do the opposite and fail when their DOM node was
 *    replaced or semantically recycled.
 */
export class RefRegistry {
  private readonly entries = new Map<string, RefEntry>();
  private snapshotGeneration = 0;

  /** Erase all tracked refs and release their browser-side handles. */
  clear(): void {
    for (const entry of this.entries.values()) {
      if (entry.handle) void entry.handle.dispose().catch(() => undefined);
    }
    this.entries.clear();
  }

  /** Most recent snapshot generation for diagnostics/telemetry. */
  generation(): number {
    return this.snapshotGeneration;
  }

  /**
   * Parse a Playwright `ariaSnapshot({mode:"ai"})` YAML output and record
   * every node that contains `[ref=...]`.
   *
   * When `pageGeneration` is non-zero (the production path), the snapshot
   * returned to the caller contains opaque generation-qualified tokens such
   * as `p2s3_r7`. Unit/parser callers that omit a page generation retain the
   * raw Playwright ref strings so the parser remains testable without a
   * browser.
   */
  ingest(snapshotYaml: string, _page?: Page, pageGeneration = 0): RefIngestResult {
    this.clear();
    const snapshotGeneration = ++this.snapshotGeneration;
    const nodes = parseAiSnapshot(snapshotYaml);
    const frameIndex = new Map<string, number>();
    const replacements = new Map<string, string>();

    let ordinal = 0;
    for (const node of nodes) {
      const key = node.role + "\u0001" + node.name;
      const nth = frameIndex.get(node.frameUrl + "\u0001" + key) ?? 0;
      frameIndex.set(node.frameUrl + "\u0001" + key, nth + 1);
      node.index = nth;

      const sourceRef = node.ref;
      const externalRef =
        pageGeneration > 0 ? `p${pageGeneration}s${snapshotGeneration}_r${++ordinal}` : sourceRef;
      replacements.set(sourceRef, externalRef);
      this.entries.set(externalRef, {
        ...node,
        ref: externalRef,
        sourceRef,
        pageGeneration,
        snapshotGeneration,
      });
    }

    const snapshot =
      pageGeneration > 0
        ? snapshotYaml.replace(/\[ref=([^\]]+)\]/g, (full, sourceRef: string) => {
            const replacement = replacements.get(sourceRef);
            return replacement ? `[ref=${replacement}]` : full;
          })
        : snapshotYaml;

    return { registered: nodes.length, snapshot, snapshotGeneration };
  }

  /**
   * Pin every currently registered ref to the exact DOM element that existed
   * when the snapshot was captured. Binding is all-or-nothing: a snapshot
   * whose refs cannot be pinned is rejected instead of returning unreliable
   * tokens.
   */
  async bindHandles(page: Page, expectedSnapshotGeneration = this.snapshotGeneration): Promise<void> {
    if (expectedSnapshotGeneration !== this.snapshotGeneration) {
      throw new Error("Snapshot generation changed before refs could be bound");
    }

    const entries = Array.from(this.entries.values());
    try {
      for (const entry of entries) {
        if (entry.snapshotGeneration !== expectedSnapshotGeneration) continue;
        // Playwright's AI snapshot owns the authoritative ref -> element map.
        // Its aria-ref selector resolves that exact captured element (including
        // cross-frame fNeN refs) from the snapshot cache. Reconstructing the
        // target from role/name can wait on, or silently choose, a different
        // generic element. Source refs are Playwright-generated opaque tokens;
        // validate their expected grammar before interpolating a selector.
        if (!/^(?:e\d+|f\d+e\d+)$/.test(entry.sourceRef)) {
          throw new StaleRefError(entry.ref, "contains an invalid Playwright source ref");
        }
        const handle = await page.locator(`aria-ref=${entry.sourceRef}`).elementHandle();
        if (!handle) {
          throw new StaleRefError(entry.ref, "could not be resolved to the captured DOM element");
        }
        const fingerprint = await fingerprintElement(handle);

        if (
          expectedSnapshotGeneration !== this.snapshotGeneration ||
          this.entries.get(entry.ref) !== entry
        ) {
          await handle.dispose().catch(() => undefined);
          throw new Error("Snapshot generation changed while refs were being bound");
        }

        entry.handle = handle;
        entry.fingerprint = fingerprint;
      }
    } catch (err) {
      this.clear();
      throw err;
    }
  }

  /**
   * Look up a ref by its emitted key. Returns null when the ref has never
   * been registered for the current snapshot.
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
  constructor(public readonly ref: string, detail = "is no longer valid") {
    super(`Ref '${ref}' ${detail}. Take a new browser_snapshot and try again.`);
    this.name = "StaleRefError";
  }
}

/**
 * Snapshot-bound action target. Unlike a Locator, this object never
 * re-resolves to a replacement DOM node. Every action revalidates the pinned
 * element's connectivity and semantic fingerprint immediately before use;
 * ElementHandle actions then fail if the node detaches during the action.
 */
export class ResolvedRef {
  constructor(
    private readonly page: Page,
    private readonly entry: RefEntry,
  ) {}

  async click(): Promise<void> {
    await (await this.currentHandle()).click();
  }

  async fill(value: string): Promise<void> {
    await (await this.currentHandle()).fill(value);
  }

  async hover(): Promise<void> {
    await (await this.currentHandle()).hover();
  }

  async selectOption(value: string | { label: string }): Promise<string[]> {
    return (await this.currentHandle()).selectOption(value);
  }

  async dragTo(target: ResolvedRef): Promise<void> {
    const sourceHandle = await this.currentHandle();
    const targetHandle = await target.currentHandle();
    await sourceHandle.hover();
    await this.page.mouse.down();
    try {
      await targetHandle.hover();
      // Playwright documents that some dragover implementations require a
      // second move to the drop target in order to dispatch dragover.
      await targetHandle.hover();
    } finally {
      await this.page.mouse.up();
    }
  }

  private async currentHandle(): Promise<PinnedElement> {
    const { handle, fingerprint } = this.entry;
    if (!handle || !fingerprint) {
      throw new StaleRefError(this.entry.ref, "was not bound to the captured DOM element");
    }

    try {
      const connected = await handle.evaluate((element) => element.isConnected);
      if (!connected) {
        throw new StaleRefError(this.entry.ref, "was detached from the DOM after its snapshot");
      }
      const currentFingerprint = await fingerprintElement(handle);
      if (currentFingerprint !== fingerprint) {
        throw new StaleRefError(
          this.entry.ref,
          "no longer matches the element captured by its snapshot",
        );
      }
      return handle;
    } catch (err) {
      if (err instanceof StaleRefError) throw err;
      throw new StaleRefError(this.entry.ref, "became stale after its snapshot");
    }
  }
}

/**
 * Resolve a registered ref to its snapshot-bound action target. Unknown or
 * superseded generation tokens fail immediately instead of being guessed.
 */
export function resolveRef(page: Page, registry: RefRegistry, ref: string): ResolvedRef {
  const entry = registry.get(ref);
  if (!entry) throw new StaleRefError(ref);
  return new ResolvedRef(page, entry);
}

/**
 * Hash a small semantic fingerprint instead of persisting/logging page text.
 * This catches virtualized/recycled DOM nodes that remain connected while
 * changing meaning between snapshot and action.
 */
async function fingerprintElement(handle: PinnedElement): Promise<string> {
  const fields = await handle.evaluate((element) => {
    const compact = (value: string | null | undefined) =>
      (value ?? "").replace(/\s+/g, " ").trim();
    const labelledBy = compact(element.getAttribute("aria-labelledby"))
      .split(" ")
      .filter(Boolean)
      .map((id) => compact(element.ownerDocument.getElementById(id)?.textContent))
      .join(" ");
    const labels =
      "labels" in element && (element as HTMLInputElement).labels
        ? Array.from((element as HTMLInputElement).labels ?? [], (label) => compact(label.textContent)).join(" ")
        : "";
    const renderedText =
      "innerText" in element
        ? compact((element as HTMLElement).innerText)
        : compact(element.textContent);

    return {
      tag: element.tagName,
      role: compact(element.getAttribute("role")),
      ariaLabel: compact(element.getAttribute("aria-label")),
      labelledBy: compact(labelledBy),
      labels: compact(labels),
      name: compact(element.getAttribute("name")),
      type: compact(element.getAttribute("type")),
      title: compact(element.getAttribute("title")),
      placeholder: compact(element.getAttribute("placeholder")),
      alt: compact(element.getAttribute("alt")),
      text: renderedText,
    };
  });
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

/**
 * Walk the `ariaSnapshot({mode:"ai"})` YAML and pull out every node that has
 * a `[ref=...]` marker.
 */
function parseAiSnapshot(yamlText: string): Array<RefEntry & { index: number }> {
  const out: Array<RefEntry & { index: number }> = [];
  if (!yamlText.trim()) return out;
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
  if (Array.isArray(obj.iframes)) {
    for (const frame of obj.iframes) walk(frame, frameUrl, out);
  }
  for (const [key, value] of Object.entries(obj)) {
    if (key === "iframes") continue;
    if (typeof value === "string") {
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
  const beforeRef = scalar.slice(0, refMatch.index).trim();
  const head = beforeRef.replace(/\[[^\]]*\]\s*$/, "").trim();
  const roleName = head.match(/^([\w-]+)\s*(?:"([^"]*)"|'([^']*)')?\s*(?::\s*(.*))?$/);
  if (!roleName) return;
  const role = roleName[1]!;
  let name = roleName[2] ?? roleName[3] ?? (roleName[4] ?? "").trim();
  if (!name && nameHint && !nameHint.includes("[ref=")) {
    name = nameHint.trim();
  }
  out.push({
    ref: refMatch[1]!,
    sourceRef: refMatch[1]!,
    role,
    name,
    frameUrl,
    index: 0,
    pageGeneration: 0,
    snapshotGeneration: 0,
  });
}
