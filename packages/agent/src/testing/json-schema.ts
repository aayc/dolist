/**
 * A synthesizer for minimal schema-valid values, and the validator (`tools/json-schema`) that
 * mirrors what the harness enforces before a tool runs.
 */
import type { JsonSchema } from "@ddl/core";
import { deepEqual, isPlainObject, isSchema, typeList, validateJson } from "../tools/json-schema";

export { validateJson } from "../tools/json-schema";

type Schema = Record<string, unknown>;

/**
 * A minimal value that satisfies `schema`: required properties only, enums' first option, bounds
 * respected. `hints` fill string/number/boolean properties by name (e.g. `{ command: "ls" }`).
 */
export function synthesizeJson(schema: JsonSchema, hints: Record<string, unknown> = {}): unknown {
  return synth(schema as Schema, hints, undefined, 0);
}

function synth(
  s: Schema,
  hints: Record<string, unknown>,
  name: string | undefined,
  depth: number,
): unknown {
  if ("const" in s) return s.const;
  if (Array.isArray(s.enum) && s.enum.length > 0) {
    const hinted = name !== undefined ? hints[name] : undefined;
    return hinted !== undefined && s.enum.some((v) => deepEqual(v, hinted)) ? hinted : s.enum[0];
  }
  const hinted = name !== undefined ? hints[name] : undefined;
  for (const key of ["anyOf", "oneOf"] as const) {
    const options = s[key];
    if (!Array.isArray(options) || options.length === 0) continue;
    const fitting = options.find(
      (option) => hinted !== undefined && validateJson(option as Schema, hinted).length === 0,
    );
    if (fitting) return hinted;
    // Strict (OpenAI-style) schemas mark optional fields required-but-nullable: null means "not given".
    const nullable = options.find((option) => typeList((option as Schema).type).includes("null"));
    return nullable ? null : synth(options[0] as Schema, hints, name, depth);
  }
  if (hinted !== undefined && validateJson(s, hinted).length === 0) return hinted;
  const type = typeList(s.type)[0] ?? (isPlainObject(s.properties) ? "object" : "string");
  switch (type) {
    case "object": {
      const out: Record<string, unknown> = {};
      if (depth > 8) return out;
      const properties = isPlainObject(s.properties)
        ? (s.properties as Record<string, Schema>)
        : {};
      for (const key of Array.isArray(s.required) ? s.required : []) {
        if (typeof key === "string") out[key] = synth(properties[key] ?? {}, hints, key, depth + 1);
      }
      for (const [key, propertySchema] of Object.entries(properties)) {
        if (out[key] === undefined && hints[key] !== undefined) {
          const value = synth(propertySchema, hints, key, depth + 1);
          if (validateJson(propertySchema, value).length === 0) out[key] = value;
        }
      }
      return out;
    }
    case "array": {
      const min = typeof s.minItems === "number" ? s.minItems : 0;
      const items = isSchema(s.items) ? (s.items as Schema) : {};
      const base = synth(items, hints, undefined, depth + 1);
      return Array.from({ length: min }, (_, i) => {
        if (s.uniqueItems !== true || i === 0) return base;
        if (Array.isArray(items.enum) && items.enum.length > 0)
          return items.enum[i % items.enum.length];
        return typeof base === "string" ? `${base}-${i + 1}` : base;
      });
    }
    case "integer":
    case "number": {
      const min = typeof s.minimum === "number" ? s.minimum : undefined;
      const max = typeof s.maximum === "number" ? s.maximum : undefined;
      const value = min ?? (max !== undefined ? Math.min(0, max) : 0);
      return type === "integer" ? Math.ceil(value) : value;
    }
    case "boolean":
      return false;
    case "null":
      return null;
    default: {
      const min = typeof s.minLength === "number" ? s.minLength : 1;
      const base = name ? `example ${name}` : "example";
      const padded = base.length >= min ? base : base.padEnd(min, "x");
      return typeof s.maxLength === "number" ? padded.slice(0, s.maxLength) : padded;
    }
  }
}
