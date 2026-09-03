import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { zodToJsonSchema } from "zod-to-json-schema";

import { policyTools } from "../src/policy/tools.ts";
import { toolInputSchema } from "../src/server.ts";
import { allTools, type ToolDef } from "../src/tools.ts";

interface CallCase {
  args: unknown;
  valid: boolean;
  label: string;
}

const cases: Record<string, CallCase[]> = {
  browser_navigate: [
    { args: { url: "https://example.test/" }, valid: true, label: "valid URL" },
    { args: { url: "not a url" }, valid: false, label: "invalid URL" },
  ],
  browser_snapshot: [
    { args: {}, valid: true, label: "empty object" },
    { args: null, valid: false, label: "non-object" },
  ],
  browser_click: [
    { args: { ref: "p1s1_r1" }, valid: true, label: "ref target" },
    { args: { selector: "#go" }, valid: true, label: "selector target" },
    { args: { x: 10, y: 20 }, valid: true, label: "coordinate target" },
    { args: {}, valid: false, label: "missing target" },
    { args: { ref: "p1s1_r1", selector: "#go" }, valid: false, label: "conflicting targets" },
    { args: { x: 10 }, valid: false, label: "partial coordinates" },
  ],
  browser_type: [
    { args: { text: "hello" }, valid: true, label: "focused element" },
    { args: { text: "hello", ref: "p1s1_r1" }, valid: true, label: "ref target" },
    { args: { text: "hello", selector: "#name" }, valid: true, label: "selector target" },
    {
      args: { text: "hello", ref: "p1s1_r1", selector: "#name" },
      valid: false,
      label: "conflicting explicit targets",
    },
    { args: {}, valid: false, label: "missing text" },
  ],
  browser_fill: [
    { args: { selector: "#name", value: "Ada" }, valid: true, label: "selector target" },
    { args: { ref: "p1s1_r1", value: "Ada" }, valid: true, label: "ref target" },
    { args: { value: "Ada" }, valid: false, label: "missing target" },
    {
      args: { ref: "p1s1_r1", selector: "#name", value: "Ada" },
      valid: false,
      label: "conflicting targets",
    },
  ],
  browser_press: [
    { args: { key: "Enter" }, valid: true, label: "key" },
    { args: {}, valid: false, label: "missing key" },
  ],
  browser_hover: [
    { args: { selector: "#menu" }, valid: true, label: "selector target" },
    { args: { ref: "p1s1_r1" }, valid: true, label: "ref target" },
    { args: {}, valid: false, label: "missing target" },
    {
      args: { ref: "p1s1_r1", selector: "#menu" },
      valid: false,
      label: "conflicting targets",
    },
  ],
  browser_drag: [
    {
      args: { fromRef: "p1s1_r1", toSelector: "#drop" },
      valid: true,
      label: "mixed ref to selector",
    },
    {
      args: { fromSelector: "#drag", toRef: "p1s1_r2" },
      valid: true,
      label: "mixed selector to ref",
    },
    {
      args: { fromRef: "p1s1_r1", fromSelector: "#drag", toSelector: "#drop" },
      valid: false,
      label: "conflicting source targets",
    },
    {
      args: { fromSelector: "#drag", toRef: "p1s1_r2", toSelector: "#drop" },
      valid: false,
      label: "conflicting destination targets",
    },
    { args: { fromSelector: "#drag" }, valid: false, label: "missing destination" },
  ],
  browser_select: [
    { args: { selector: "#country", value: "my" }, valid: true, label: "selector plus value" },
    { args: { ref: "p1s1_r1", label: "Malaysia" }, valid: true, label: "ref plus label" },
    { args: { selector: "#country" }, valid: false, label: "missing option" },
    {
      args: { selector: "#country", value: "my", label: "Malaysia" },
      valid: false,
      label: "conflicting option modes",
    },
  ],
  browser_screenshot: [
    { args: {}, valid: true, label: "defaults" },
    { args: { fullPage: "yes" }, valid: false, label: "wrong boolean type" },
  ],
  browser_evaluate: [
    { args: { expression: "1 + 1" }, valid: true, label: "expression" },
    { args: {}, valid: false, label: "missing expression" },
  ],
  browser_wait: [
    { args: {}, valid: true, label: "empty wait" },
    { args: { time: 0.01 }, valid: true, label: "time wait" },
    { args: { time: -1 }, valid: false, label: "negative time" },
  ],
  browser_console: [
    { args: {}, valid: true, label: "defaults" },
    { args: { level: "warn", limit: 5 }, valid: true, label: "bounded query" },
    { args: { limit: 0 }, valid: false, label: "zero limit" },
  ],
  browser_network: [
    { args: {}, valid: true, label: "defaults" },
    { args: { static: true, limit: 5 }, valid: true, label: "include static" },
    { args: { limit: 0 }, valid: false, label: "zero limit" },
  ],
  browser_captcha_solve: [
    {
      args: { siteKey: "site", pageUrl: "https://example.test/" },
      valid: true,
      label: "valid challenge",
    },
    { args: { siteKey: "site", pageUrl: "not a url" }, valid: false, label: "invalid page URL" },
  ],
  browser_propose_action: [
    {
      args: { tool: "browser_click", arguments: { selector: "#go" } },
      valid: true,
      label: "proposal",
    },
    { args: {}, valid: false, label: "missing proposal fields" },
  ],
  browser_approve_action: [
    {
      args: { envelopeDigest: "a".repeat(64), approverId: "user" },
      valid: true,
      label: "approval",
    },
    {
      args: { envelopeDigest: "short", approverId: "user" },
      valid: false,
      label: "invalid digest",
    },
  ],
};

const tools = [...allTools, ...policyTools];
const passthroughTools = new Set(["browser_snapshot", "browser_propose_action"]);
const crossFieldTools = new Set([
  "browser_click",
  "browser_type",
  "browser_fill",
  "browser_hover",
  "browser_drag",
  "browser_select",
]);

function byName(name: string): ToolDef {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

describe("MCP JSON Schema and runtime validation corpus (#4)", () => {
  it("covers every advertised tool", () => {
    assert.deepEqual(
      Object.keys(cases).sort(),
      tools.map((tool) => tool.name).sort(),
    );
  });

  it("draft-07 wire validation and runtime Zod agree with the canonical corpus", () => {
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);

    for (const [name, toolCases] of Object.entries(cases)) {
      const tool = byName(name);
      const validate = ajv.compile(toolInputSchema(tool.schema));

      for (const testCase of toolCases) {
        const runtimeValid = tool.schema.safeParse(testCase.args).success;
        const wireValid = validate(testCase.args) as boolean;
        assert.equal(
          runtimeValid,
          testCase.valid,
          `${name} runtime disagrees for ${testCase.label}`,
        );
        assert.equal(
          wireValid,
          testCase.valid,
          `${name} wire schema disagrees for ${testCase.label}: ${ajv.errorsText(validate.errors)}`,
        );
        assert.equal(
          runtimeValid,
          wireValid,
          `${name} runtime/wire mismatch for ${testCase.label}`,
        );
      }
    }
  });

  it("wire and runtime agree on undeclared properties", () => {
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);

    for (const tool of tools) {
      const seed = cases[tool.name].find((testCase) => testCase.valid);
      assert.ok(seed && typeof seed.args === "object" && seed.args !== null, `${tool.name} needs an object seed`);
      const args = { ...(seed.args as Record<string, unknown>), __unknown: true };
      const expected = passthroughTools.has(tool.name);
      const runtimeValid = tool.schema.safeParse(args).success;
      const validate = ajv.compile(toolInputSchema(tool.schema));
      const wireValid = validate(args) as boolean;

      assert.equal(runtimeValid, expected, `${tool.name} runtime undeclared-property contract`);
      assert.equal(
        wireValid,
        expected,
        `${tool.name} wire undeclared-property contract: ${ajv.errorsText(validate.errors)}`,
      );
      assert.equal(runtimeValid, wireValid, `${tool.name} undeclared-property runtime/wire mismatch`);
    }
  });

  it("raw Zod JSON Schema carries representable cross-field contracts without server patches", () => {
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);

    for (const name of crossFieldTools) {
      const tool = byName(name);
      const rawSchema = zodToJsonSchema(tool.schema, { target: "jsonSchema7" }) as Record<string, unknown>;
      const validate = ajv.compile(rawSchema);

      for (const testCase of cases[name]) {
        const rawValid = validate(testCase.args) as boolean;
        assert.equal(
          rawValid,
          testCase.valid,
          `${name} raw generated schema disagrees for ${testCase.label}: ${ajv.errorsText(validate.errors)}`,
        );
      }
    }
  });
});
