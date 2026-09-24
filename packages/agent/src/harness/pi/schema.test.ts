import { validateToolArguments } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import { describe, expect, it } from "vitest";
import { InvalidToolSchemaError, normalizeToolSchema } from "./schema";

/** Runs the exact validation Pi applies to tool calls before execution. */
function piValidate(schema: Record<string, unknown>, args: Record<string, unknown>): unknown {
  return validateToolArguments(
    { name: "t", description: "", parameters: normalizeToolSchema(schema).schema as TSchema },
    { type: "toolCall", id: "call_1", name: "t", arguments: args as never },
  );
}

describe("normalizeToolSchema", () => {
  it("keeps the common subset intact", () => {
    const input = {
      type: "object",
      description: "Book a table",
      properties: {
        name: { type: "string", description: "Guest name", minLength: 1 },
        size: { type: "integer", minimum: 1, maximum: 20, default: 2 },
        vip: { type: "boolean" },
        when: { type: "string", format: "date-time" },
        tags: { type: "array", items: { type: "string", enum: ["quiet", "window"] } },
        seating: { anyOf: [{ const: "inside" }, { const: "outside" }] },
        contact: { oneOf: [{ type: "string" }, { type: "number" }] },
      },
      required: ["name", "size"],
      additionalProperties: false,
    };
    const { schema, warnings, degraded } = normalizeToolSchema(input);
    expect(schema).toEqual(input);
    expect(schema).not.toBe(input);
    expect(warnings).toEqual([]);
    expect(degraded).toBe(false);
  });

  it("adds a missing object root and properties", () => {
    expect(normalizeToolSchema({}).schema).toEqual({ type: "object", properties: {} });
    expect(normalizeToolSchema({ properties: { a: { type: "string" } } }).schema).toEqual({
      type: "object",
      properties: { a: { type: "string" } },
    });
    expect(normalizeToolSchema({ type: ["object", "null"] }).schema.type).toBe("object");
  });

  it("rejects non-object roots", () => {
    expect(() => normalizeToolSchema({ type: "string" })).toThrow(InvalidToolSchemaError);
  });

  it("converts OpenAPI nullable to JSON Schema", () => {
    const { schema } = normalizeToolSchema({
      type: "object",
      properties: {
        a: { type: "string", nullable: true },
        b: { type: "string", enum: ["x", "y"], nullable: true },
        c: { anyOf: [{ type: "string" }, { type: "number" }], nullable: true, description: "C" },
        d: { type: "number", nullable: false },
      },
    });
    expect(schema.properties).toEqual({
      a: { type: ["string", "null"] },
      b: { type: ["string", "null"], enum: ["x", "y", null] },
      c: {
        description: "C",
        anyOf: [{ anyOf: [{ type: "string" }, { type: "number" }] }, { type: "null" }],
      },
      d: { type: "number" },
    });
    expect(
      piValidate(
        { type: "object", properties: { a: { type: "string", nullable: true } }, required: ["a"] },
        { a: null },
      ),
    ).toEqual({ a: null });
  });

  it("inlines local $refs and drops unused definitions and meta keywords", () => {
    const { schema, warnings } = normalizeToolSchema({
      $schema: "http://json-schema.org/draft-07/schema#",
      $id: "https://example.com/tool",
      type: "object",
      definitions: {
        Point: { type: "object", properties: { x: { type: "number" } }, required: ["x"] },
      },
      $defs: { Label: { type: "string", description: "Label" } },
      properties: {
        at: { $ref: "#/definitions/Point" },
        label: { $ref: "#/$defs/Label", description: "Overrides" },
      },
    });
    expect(warnings).toEqual([]);
    expect(schema).toEqual({
      type: "object",
      properties: {
        at: { type: "object", properties: { x: { type: "number" } }, required: ["x"] },
        label: { type: "string", description: "Overrides" },
      },
    });
  });

  it("keeps recursive refs resolvable", () => {
    const input = {
      type: "object",
      $defs: {
        Node: {
          type: "object",
          properties: {
            name: { type: "string" },
            children: { type: "array", items: { $ref: "#/$defs/Node" } },
          },
        },
      },
      properties: { tree: { $ref: "#/$defs/Node" } },
    };
    const { schema, degraded } = normalizeToolSchema(input);
    expect(degraded).toBe(false);
    expect(schema.$defs).toBeDefined();
    expect(
      piValidate(input, { tree: { name: "root", children: [{ name: "leaf", children: [] }] } }),
    ).toEqual({ tree: { name: "root", children: [{ name: "leaf", children: [] }] } });
  });

  it("replaces unresolvable refs with an open schema", () => {
    const { schema, warnings } = normalizeToolSchema({
      type: "object",
      properties: {
        a: { $ref: "https://example.com/other.json" },
        b: { $ref: "#/nope", description: "B" },
      },
    });
    expect(schema.properties).toEqual({ a: {}, b: { description: "B" } });
    expect(warnings).toHaveLength(2);
  });

  it("drops invalid regular expressions instead of failing every call", () => {
    const { schema, warnings } = normalizeToolSchema({
      type: "object",
      properties: {
        a: { type: "string", pattern: "(?<=x" },
        b: { type: "string", pattern: "^[a-z]+$" },
      },
      patternProperties: { "(": { type: "string" }, "^x-": { type: "number" } },
    });
    expect(schema.properties).toEqual({
      a: { type: "string" },
      b: { type: "string", pattern: "^[a-z]+$" },
    });
    expect(schema.patternProperties).toEqual({ "^x-": { type: "number" } });
    expect(warnings).toHaveLength(2);
    expect(piValidate(schema, { a: "anything" })).toEqual({ a: "anything" });
  });

  it("upgrades draft-04 exclusive bounds", () => {
    const { schema } = normalizeToolSchema({
      type: "object",
      properties: {
        a: { type: "number", minimum: 0, exclusiveMinimum: true },
        b: { type: "number", maximum: 5, exclusiveMaximum: false },
      },
    });
    expect(schema.properties).toEqual({
      a: { type: "number", exclusiveMinimum: 0 },
      b: { type: "number", maximum: 5 },
    });
  });

  it("does not treat property names as keywords", () => {
    const { schema } = normalizeToolSchema({
      type: "object",
      properties: {
        id: { type: "string" },
        $schema: { type: "string" },
        nullable: { type: "boolean" },
      },
    });
    expect(Object.keys(schema.properties as object)).toEqual(["id", "$schema", "nullable"]);
  });

  it("coerces sloppy model arguments through Pi's validator", () => {
    const schema = {
      type: "object",
      properties: {
        count: { type: "integer" },
        flag: { type: "boolean" },
        note: { type: "string" },
      },
      required: ["count"],
    };
    expect(piValidate(schema, { count: "3", flag: "true", note: null })).toEqual({
      count: 3,
      flag: true,
    });
    expect(() => piValidate(schema, {})).toThrow(/count/);
  });

  it("caches per input object", () => {
    const input = { type: "object", properties: {} };
    expect(normalizeToolSchema(input)).toBe(normalizeToolSchema(input));
  });
});
