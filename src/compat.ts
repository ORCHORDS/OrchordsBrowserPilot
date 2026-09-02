import { createRequire } from "node:module";

const MIN_PLAYWRIGHT = [1, 59, 1] as const;
const NEXT_UNSUPPORTED_MAJOR = 2;

function parseVersion(version: string): [number, number, number] | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compare(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

export function assertSupportedPlaywrightVersion(version: string): void {
  const parsed = parseVersion(version);
  if (!parsed) {
    throw new Error(`orchords-web-pilot cannot determine installed Playwright version from '${version}'`);
  }
  if (parsed[0] >= NEXT_UNSUPPORTED_MAJOR || compare(parsed, MIN_PLAYWRIGHT) < 0) {
    throw new Error(
      `orchords-web-pilot requires Playwright >=1.59.1 <2.0.0; installed version is ${version}. ` +
        "Install a supported Playwright release before starting Web Pilot.",
    );
  }
}

export function assertInstalledPlaywrightSupported(): void {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("playwright/package.json") as { version?: unknown };
    if (typeof pkg.version !== "string") {
      throw new Error("package metadata does not contain a version string");
    }
    assertSupportedPlaywrightVersion(pkg.version);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("orchords-web-pilot")) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`orchords-web-pilot cannot determine installed Playwright version: ${message}`);
  }
}
