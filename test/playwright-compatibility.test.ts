import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

function minor(versionRange: string): number {
  const match = versionRange.match(/(\d+)\.(\d+)/);
  if (!match) throw new Error(`cannot parse version range: ${versionRange}`);
  const major = Number(match[1]);
  const minorVersion = Number(match[2]);
  assert.equal(major, 1, "Playwright major must stay on 1.x until compatibility policy says otherwise");
  return minorVersion;
}

describe("Playwright compatibility contract (#105)", () => {
  it("declares a minimum version that supports ariaSnapshot({ mode: 'ai' })", async () => {
    const raw = await readFile(new URL("../package.json", import.meta.url), "utf8");
    const pkg = JSON.parse(raw) as { dependencies?: Record<string, string> };
    const range = pkg.dependencies?.playwright;
    assert.ok(range, "package.json must declare playwright");
    assert.ok(
      minor(range) >= 59,
      `playwright range ${range} advertises versions older than 1.59, but Web Pilot uses ariaSnapshot({ mode: 'ai' })`,
    );
  });
});
