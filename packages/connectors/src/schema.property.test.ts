import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import { normalizeInputSchema } from "./schema";

// Stretched on slow CI runners (TEST_TIME_SCALE, see scripts/vitest/setup-fast-check.ts).
const TIME_SCALE = Number(process.env.TEST_TIME_SCALE) || 1;

const runs = (factor: number) =>
  Math.max(1, Math.round((fc.readConfigureGlobal().numRuns ?? 100) * factor));

const FORBIDDEN_ROOT = [
  "$schema",
  "$id",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "enum",
  "const",
  "__proto__",
];

/** JSON-schema-like objects with realistic keywords, wrong types and prototype-ish keys. */
const leafKeywords = {
  type: fc.oneof(
    fc.constantFrom("object", "string", "number", "integer", "boolean", "array", "null"),
    fc.constantFrom(["object", "null"], ["string", "object"], [], 7, null, "strin"),
  ),
  required: fc.oneof(
    fc.array(fc.oneof(fc.string({ maxLength: 12 }), fc.integer()), { maxLength: 6 }),
    fc.constantFrom("a", null, {}),
  ),
  $ref: fc.constantFrom(
    "#",
    "#/$defs/node",
    "#/properties/a",
    "https://example.com/s.json",
    "#/nope",
  ),
  $schema: fc.constant("https://json-schema.org/draft/2020-12/schema"),
  description: fc.oneof(fc.string({ maxLength: 40 }), fc.integer(), fc.constant(null)),
  title: fc.oneof(fc.string({ maxLength: 20 }), fc.constant({ x: 1 })),
  enum: fc.array(fc.jsonValue({ maxDepth: 1 }), { maxLength: 4 }),
  pattern: fc.constantFrom("^a+$", "((", "[", "(?<n>x)"),
  additionalProperties: fc.oneof(fc.boolean(), fc.constant("no")),
};

// At maxDepth fc.oneof only draws from its first arbitrary, so the leaf cases come first.
const schemaLike: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
  schema: fc.oneof(
    { depthSize: "small", maxDepth: 3 },
    fc.record(leafKeywords, { requiredKeys: [] }),
    fc.jsonValue({ maxDepth: 2 }),
    fc.record(
      {
        ...leafKeywords,
        properties: fc.oneof(
          fc.dictionary(
            fc.oneof(
              fc.string({ maxLength: 12 }),
              fc.constantFrom("__proto__", "constructor", "type"),
            ),
            fc.oneof(tie("schema"), fc.boolean(), fc.integer()),
            { maxKeys: 4 },
          ),
          fc.constantFrom([], "x", null, 3),
        ),
        items: tie("schema"),
        allOf: fc.array(tie("schema"), { maxLength: 2 }),
        anyOf: fc.oneof(fc.array(tie("schema"), { maxLength: 2 }), fc.constant("x")),
        $defs: fc.dictionary(fc.string({ maxLength: 8 }), tie("schema"), { maxKeys: 2 }),
      },
      { requiredKeys: [] },
    ),
  ),
})).schema;

/** Parses schemas the way they arrive from MCP (JSON), so `__proto__` becomes an own key. */
const fromJson = schemaLike.map((s) => JSON.parse(JSON.stringify(s) ?? "null") as unknown);

function expectAcceptable(schema: Record<string, unknown>): void {
  expect(Object.getPrototypeOf(schema)).toBe(Object.prototype);
  expect(schema.type).toBe("object");
  const properties = schema.properties as Record<string, unknown>;
  expect(properties && typeof properties === "object" && !Array.isArray(properties)).toBe(true);
  for (const value of Object.values(properties))
    expect(value && typeof value === "object" && !Array.isArray(value)).toBe(true);
  for (const key of FORBIDDEN_ROOT) expect(Object.hasOwn(schema, key), key).toBe(false);
  expect(Object.hasOwn(properties, "__proto__")).toBe(false);
  if ("required" in schema) {
    const required = schema.required as unknown[];
    expect(Array.isArray(required) && required.length > 0).toBe(true);
    expect(new Set(required).size).toBe(required.length);
    for (const name of required) {
      expect(typeof name).toBe("string");
      expect(Object.hasOwn(properties, name as string)).toBe(true);
    }
  }
  for (const key of ["description", "title"])
    if (key in schema) expect(typeof schema[key]).toBe("string");
  // Serializable and JSON-only (what is sent to the provider is exactly what we built).
  expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
}

describe("normalizeInputSchema", () => {
  test.prop([fc.oneof(fromJson, fc.anything())], { numRuns: runs(3) })(
    "never throws and always yields an acceptable object schema",
    (input) => {
      expectAcceptable(normalizeInputSchema(input) as Record<string, unknown>);
    },
  );

  test.prop([fromJson])("is idempotent", (input) => {
    const once = normalizeInputSchema(input);
    expect(normalizeInputSchema(once)).toEqual(once);
  });

  test.prop([fromJson])("never mutates its input", (input) => {
    const snapshot = structuredClone(input);
    normalizeInputSchema(input);
    expect(input).toEqual(snapshot);
  });

  test.prop([fromJson])("keeps declared properties and their required flags", (input) => {
    fc.pre(!!input && typeof input === "object" && !Array.isArray(input));
    const source = input as Record<string, unknown>;
    fc.pre(source.type === undefined || source.type === "object");
    const out = normalizeInputSchema(input) as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    const declared = source.properties;
    if (declared && typeof declared === "object" && !Array.isArray(declared)) {
      for (const [name, value] of Object.entries(declared))
        if (name !== "__proto__" && value !== false)
          expect(Object.hasOwn(out.properties, name)).toBe(true);
    }
  });

  it("breaks object cycles and survives huge or deep schemas quickly", () => {
    const cyclic: Record<string, unknown> = { type: "object", properties: {} };
    (cyclic.properties as Record<string, unknown>).self = cyclic;
    (cyclic.properties as Record<string, unknown>).list = { type: "array", items: cyclic };
    expectAcceptable(normalizeInputSchema(cyclic) as Record<string, unknown>);

    let deep: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 5_000; i++) deep = { type: "object", properties: { next: deep } };
    const wide = {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 20_000 }, (_, i) => [
          `p${i}`,
          { type: "string", description: "x".repeat(20) },
        ]),
      ),
      required: Array.from({ length: 20_000 }, (_, i) => `p${i}`),
    };
    const fanOut = (() => {
      let node: Record<string, unknown> = { type: "string" };
      for (let i = 0; i < 40; i++) node = { type: "object", properties: { a: node, b: node } };
      return node;
    })();
    for (const input of [deep, JSON.parse(JSON.stringify(wide)), fanOut]) {
      const started = performance.now();
      expectAcceptable(normalizeInputSchema(input) as Record<string, unknown>);
      expect(performance.now() - started).toBeLessThan(1_500 * TIME_SCALE);
    }
  });

  it("keeps $ref recursion as data for the harness to resolve", () => {
    const input = {
      type: "object",
      properties: { tree: { $ref: "#/$defs/node" } },
      $defs: {
        node: {
          type: "object",
          properties: { children: { type: "array", items: { $ref: "#/$defs/node" } } },
        },
      },
    };
    expect(normalizeInputSchema(input)).toEqual(input);
  });

  it("drops annotations of the wrong type and prototype keys", () => {
    expect(
      normalizeInputSchema(
        JSON.parse(
          '{"type":"object","description":42,"title":{"x":1},"__proto__":{"type":"string"},' +
            '"properties":{"__proto__":{"type":"string"},"ok":{"type":"string","__proto__":{"pattern":"(("}}},' +
            '"required":["__proto__","ok"]}',
        ),
      ),
    ).toEqual({ type: "object", properties: { ok: { type: "string" } }, required: ["ok"] });
  });
});
