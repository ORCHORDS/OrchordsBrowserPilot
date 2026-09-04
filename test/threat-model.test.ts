import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const threatModel = new URL("../docs/security/threat-model.md", import.meta.url);

test("local Native Messaging threat boundary is explicit and release-gated (#91, #123)", async () => {
  const text = await readFile(threatModel, "utf8");
  assert.match(text, /EXT-NM-LOCAL-001/);
  assert.match(text, /Native Messaging is not a secure communication channel/i);
  assert.match(text, /same OS user\/profile/i);
  assert.match(text, /local-user compromise/i);
  assert.match(text, /MUST NOT claim resistance/i);
  assert.match(text, /#123 owns extension↔core authenticated bridge controls/);
  assert.match(text, /test\/native-host-authenticated\.test\.ts/);
});
