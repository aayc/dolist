import { describe, expect, it } from "vitest";
import { normalizeInputSchema } from "./schema";

describe("normalizeInputSchema", () => {
  it("returns an empty object schema for missing or invalid schemas", () => {
    for (const input of [undefined, null, "string", 42, [], true]) {
      expect(normalizeInputSchema(input)).toEqual({ type: "object", properties: {} });
    }
  });

  it("fills in type and properties", () => {
    expect(normalizeInputSchema({})).toEqual({ type: "object", properties: {} });
    expect(
      normalizeInputSchema({ type: ["object", "null"], properties: { a: { type: "string" } } }),
    ).toEqual({
      type: "object",
      properties: { a: { type: "string" } },
    });
  });

  it("drops root $schema/$id and keeps other keywords", () => {
    expect(
      normalizeInputSchema({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "urn:tool",
        type: "object",
        properties: { q: { type: "string" } },
        additionalProperties: false,
        description: "Search input",
        $defs: { item: { type: "string" } },
      }),
    ).toEqual({
      type: "object",
      properties: { q: { type: "string" } },
      additionalProperties: false,
      description: "Search input",
      $defs: { item: { type: "string" } },
    });
  });

  it("keeps required only for declared properties, once each", () => {
    expect(
      normalizeInputSchema({
        type: "object",
        properties: { a: { type: "string" }, b: { type: "number" } },
        required: ["a", "missing", "a", 7, "b"],
      }),
    ).toEqual({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" } },
      required: ["a", "b"],
    });
    expect(normalizeInputSchema({ required: ["ghost"] })).toEqual({
      type: "object",
      properties: {},
    });
  });

  it("folds top-level combinators into the root properties", () => {
    expect(
      normalizeInputSchema({
        type: "object",
        properties: { id: { type: "string" } },
        allOf: [{ properties: { owner: { type: "string" } }, required: ["owner"] }],
        oneOf: [
          { properties: { url: { type: "string" } }, required: ["url"] },
          { properties: { path: { type: "string" } }, required: ["path"] },
        ],
        not: { required: ["both"] },
      }),
    ).toEqual({
      type: "object",
      properties: {
        id: { type: "string" },
        owner: { type: "string" },
        url: { type: "string" },
        path: { type: "string" },
      },
      required: ["owner"],
    });
  });

  it("replaces non-object roots, keeping the description", () => {
    expect(normalizeInputSchema({ type: "string", description: "A query" })).toEqual({
      type: "object",
      properties: {},
      description: "A query",
    });
  });

  it("normalizes boolean property schemas and leaves nested schemas untouched", () => {
    const nested = { type: "object", properties: { deep: { anyOf: [{ type: "string" }] } } };
    const input = {
      properties: { any: true, never: false, weird: 5, nested },
      required: ["never"],
    };
    const snapshot = structuredClone(input);
    expect(normalizeInputSchema(input)).toEqual({
      type: "object",
      properties: { any: {}, weird: {}, nested },
    });
    expect(input).toEqual(snapshot);
  });
});
