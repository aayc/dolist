import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import type { z } from "zod";
import { invalidFor, wireArbitraries } from "../../src/testing";
import { exact, REQUEST_SCHEMA_NAMES, WIRE_SCHEMAS, type WireSchemaName } from "../../src/wire";

const names = Object.keys(WIRE_SCHEMAS) as WireSchemaName[];
const requests = new Set<string>(REQUEST_SCHEMA_NAMES);
/** Each schema gets a share of the global run budget (FC_NUM_RUNS scales all of them). */
const numRuns = Math.max(10, Math.round((fc.readConfigureGlobal().numRuns ?? 100) / 3));

/** Objects, or unions whose every option is an object (events, messages, rename results). */
function isObjectSchema(schema: z.ZodType): boolean {
  if (schema.def.type === "object") return true;
  if (schema.def.type !== "union") return false;
  return (schema as z.ZodUnion<z.ZodType[]>).options.every(isObjectSchema);
}

describe.each(names)("%s", (name) => {
  const schema: z.ZodType = WIRE_SCHEMAS[name];
  const values = wireArbitraries[name]() as fc.Arbitrary<unknown>;
  const objects = values as fc.Arbitrary<Record<string, unknown>>;

  test.prop([values], { numRuns })("generated values parse unchanged, even exactly", (value) => {
    const parsed = schema.safeParse(value);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.data).toStrictEqual(value);
    expect(exact(schema).safeParse(value).error?.issues ?? []).toEqual([]);
  });

  test.prop([values], { numRuns })("survive a JSON round trip unchanged", (value) => {
    const roundTripped: unknown = JSON.parse(JSON.stringify(value));
    expect(roundTripped).toStrictEqual(value);
    expect(schema.safeParse(roundTripped).success).toBe(true);
  });

  if (isObjectSchema(schema)) {
    test.prop([objects], { numRuns })(
      requests.has(name)
        ? "requests reject unknown keys (strict)"
        : "responses and events keep unknown keys (tolerant)",
      (value) => {
        const extended = { ...value, x_future_field: { added: "later" } };
        const parsed = schema.safeParse(extended);
        if (requests.has(name)) {
          expect(parsed.success).toBe(false);
          expect(parsed.error?.issues.some((issue) => issue.code === "unrecognized_keys")).toBe(
            true,
          );
        } else {
          expect(parsed.success).toBe(true);
          expect(parsed.data).toMatchObject({ x_future_field: { added: "later" } });
          expect(exact(schema).safeParse(extended).success).toBe(false);
        }
      },
    );
  }

  test.prop([invalidFor(schema, values)], { numRuns })("single mutations are rejected", (value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });
});

describe("robustness", () => {
  test.prop([fc.anything({ withNullPrototype: true, withBigInt: true, withDate: true })], {
    numRuns,
  })("safeParse never throws, whatever the input", (value) => {
    for (const name of names) expect(() => WIRE_SCHEMAS[name].safeParse(value)).not.toThrow();
  });
});
