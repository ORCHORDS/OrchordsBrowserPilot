import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { allTools } from "../src/tools.ts";
import { toolInputSchema } from "../src/server.ts";

function tool(name: string) {
  const t = allTools.find(t => t.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return { def: t, schema: toolInputSchema(t.schema) } as const;
}

describe("tool JSON schemas (P0 #4)", () => {
  it("every tool exposes a JSON Schema object with the right shape", () => {
    for (const t of allTools) {
      const s = toolInputSchema(t.schema) as Record<string, unknown>;
      assert.equal(typeof s, "object", `${t.name}: schema is not an object`);
      assert.equal(s.type, "object", `${t.name}: schema.type must be 'object'`);
      assert.ok("properties" in s, `${t.name}: schema should have properties`);
      assert.ok(!("$schema" in s), `${t.name}: schema should not leak $schema onto the wire`);
    }
  });

  it("navigate marks url as required and includes a uri format string", () => {
    const { schema } = tool("browser_navigate");
    const props = schema.properties as Record<string, Record<string, unknown>>;
    assert.deepEqual(schema.required, ["url"]);
    assert.equal(props.url.type, "string");
    assert.equal(props.url.format, "uri");
  });

  it("click marks only the discriminating fields correctly and respects refinement", () => {
    const { def, schema } = tool("browser_click");
    const props = schema.properties as Record<string, Record<string, unknown>>;
    // All four fields are optional in the Zod object — none should be required.
    assert.ok(!Array.isArray(schema.required) || schema.required.length === 0);
    assert.equal(props.ref.type, "string");
    assert.equal(props.selector.type, "string");
    assert.equal(props.x.type, "integer");
    assert.equal(props.x.minimum, 0);
    assert.equal(props.y.type, "integer");
    assert.equal(props.y.minimum, 0);
    // The .refine() keeps the runtime contract; the schema stays faithful.
    assert.ok(def.schema.safeParse({}).success === false, "refine must still reject empty input");
  });

  it("console_tool exposes enum + default + numeric bounds", () => {
    const { schema } = tool("browser_console");
    const props = schema.properties as Record<string, Record<string, unknown>>;
    assert.equal(props.level.type, "string");
    assert.deepEqual(props.level.enum, ["log", "info", "warn", "error", "debug"]);
    assert.equal(props.level.default, "log");
    assert.equal(props.limit.type, "integer");
    assert.equal(props.limit.exclusiveMinimum, 0);
    assert.equal(props.limit.maximum, 500);
    assert.equal(props.limit.default, 100);
  });

  it("captcha_solve exposes enum default and url format", () => {
    const { schema } = tool("browser_captcha_solve");
    const props = schema.properties as Record<string, Record<string, unknown>>;
    assert.deepEqual(props.type.enum, ["recaptcha-v2", "recaptcha-v3", "hcaptcha", "turnstile"]);
    assert.equal(props.type.default, "recaptcha-v2");
    assert.equal(props.pageUrl.format, "uri");
  });

  it("screenshot marks optional fields as not required", () => {
    const { schema } = tool("browser_screenshot");
    assert.ok(!Array.isArray(schema.required) || schema.required.length === 0);
    const props = schema.properties as Record<string, Record<string, unknown>>;
    assert.equal(props.fullPage.type, "boolean");
    assert.equal(props.savePath.type, "string");
  });
});