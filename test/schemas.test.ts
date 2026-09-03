import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { allTools } from "../src/tools.ts";
import { toolInputSchema } from "../src/server.ts";

function tool(name: string) {
  const t = allTools.find(t => t.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return { def: t, schema: toolInputSchema(t.schema) } as const;
}

function generatedBranches(schema: Record<string, unknown>, name: string): Array<Record<string, unknown>> {
  assert.ok(Array.isArray(schema.anyOf), `${name}: generated target composition must be present`);
  return schema.anyOf as Array<Record<string, unknown>>;
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

  it("click advertises the three canonical target modes on the MCP wire", () => {
    const { def, schema } = tool("browser_click");
    const props = schema.properties as Record<string, Record<string, unknown>>;
    assert.ok(!Array.isArray(schema.required) || schema.required.length === 0);
    assert.equal(props.ref.type, "string");
    assert.equal(props.selector.type, "string");
    assert.equal(props.x.type, "integer");
    assert.equal(props.x.minimum, 0);
    assert.equal(props.y.type, "integer");
    assert.equal(props.y.minimum, 0);
    assert.equal(generatedBranches(schema, "browser_click").length, 3);
    assert.equal(def.schema.safeParse({}).success, false, "runtime must reject empty input");
  });

  it("drag advertises the four canonical source/destination combinations", () => {
    const { schema } = tool("browser_drag");
    assert.equal(generatedBranches(schema, "browser_drag").length, 4);
  });

  it("fill and hover advertise generated target composition and reject ambiguous runtime input", () => {
    for (const name of ["browser_fill", "browser_hover"]) {
      const { def, schema } = tool(name);
      assert.equal(generatedBranches(schema, name).length, 2, `${name}: target modes`);
      assert.equal(
        def.schema.safeParse({ ref: "p1s1_r1", selector: "#x", ...(name === "browser_fill" ? { value: "x" } : {}) }).success,
        false,
        `${name}: runtime must reject ambiguous ref+selector`,
      );
    }
  });

  it("select advertises the four canonical target/option combinations", () => {
    const { def, schema } = tool("browser_select");
    assert.equal(generatedBranches(schema, "browser_select").length, 4);
    assert.equal(def.schema.safeParse({ selector: "#s" }).success, false, "runtime must require value or label");
    assert.equal(
      def.schema.safeParse({ ref: "p1s1_r1", selector: "#s", value: "one" }).success,
      false,
      "runtime must reject ambiguous target",
    );
    assert.equal(
      def.schema.safeParse({ selector: "#s", value: "one", label: "One" }).success,
      false,
      "runtime must reject ambiguous option mode",
    );
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