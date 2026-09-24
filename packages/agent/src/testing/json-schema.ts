/**
 * The JSON Schema subset our tools use (object/array/string/number/integer/boolean/null, enum,
 * const, required, additionalProperties, items, min/max bounds, anyOf/oneOf, nullable): a validator
 * that mirrors what the real harness enforces before a tool runs, and a synthesizer for minimal
 * schema-valid values.
 */
import type { JsonSchema } from "@ddl/core";

type Schema = Record<string, unknown>;

/** Validation errors as `path: message` strings; empty when the value matches. */
export function validateJson(schema: JsonSchema, value: unknown, path = "root"): string[] {
  const s = schema as Schema;
  const errors: string[] = [];
  if (value === null && s.nullable === true) return errors;
  for (const key of ["anyOf", "oneOf"] as const) {
    const options = s[key];
    if (Array.isArray(options) && options.length > 0) {
      const passing = options.filter(
        (option) => validateJson(option as JsonSchema, value, path).length === 0,
      );
      if (passing.length === 0) errors.push(`${path}: must match one of the allowed schemas`);
      else if (key === "oneOf" && passing.length > 1)
        errors.push(`${path}: matches more than one schema`);
    }
  }
  if ("const" in s && !deepEqual(s.const, value))
    errors.push(`${path}: must be ${JSON.stringify(s.const)}`);
  if (Array.isArray(s.enum) && !s.enum.some((option) => deepEqual(option, value))) {
    errors.push(`${path}: must be one of ${s.enum.map((v) => JSON.stringify(v)).join(", ")}`);
  }
  const types = typeList(s.type);
  if (types.length > 0 && !types.some((type) => matchesType(type, value))) {
    errors.push(`${path}: must be ${types.join(" or ")}`);
    return errors;
  }
  if (typeof value === "string") {
    if (typeof s.minLength === "number" && value.length < s.minLength) {
      errors.push(`${path}: must have at least ${s.minLength} characters`);
    }
    if (typeof s.maxLength === "number" && value.length > s.maxLength) {
      errors.push(`${path}: must have at most ${s.maxLength} characters`);
    }
  }
  if (typeof value === "number") {
    if (typeof s.minimum === "number" && value < s.minimum)
      errors.push(`${path}: must be >= ${s.minimum}`);
    if (typeof s.maximum === "number" && value > s.maximum)
      errors.push(`${path}: must be <= ${s.maximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === "number" && value.length < s.minItems) {
      errors.push(`${path}: must have at least ${s.minItems} items`);
    }
    if (typeof s.maxItems === "number" && value.length > s.maxItems) {
      errors.push(`${path}: must have at most ${s.maxItems} items`);
    }
    if (
      s.uniqueItems === true &&
      new Set(value.map((v) => JSON.stringify(v))).size !== value.length
    ) {
      errors.push(`${path}: must not contain duplicates`);
    }
    if (isSchema(s.items)) {
      for (const [i, item] of value.entries()) {
        errors.push(...validateJson(s.items as JsonSchema, item, `${path}.${i}`));
      }
    }
  }
  if (isPlainObject(value)) {
    const properties = isPlainObject(s.properties)
      ? (s.properties as Record<string, JsonSchema>)
      : {};
    for (const key of Array.isArray(s.required) ? s.required : []) {
      if (typeof key === "string" && value[key] === undefined) {
        errors.push(`${path === "root" ? key : `${path}.${key}`}: is required`);
      }
    }
    for (const [key, item] of Object.entries(value)) {
      const child = path === "root" ? key : `${path}.${key}`;
      const propertySchema = properties[key];
      if (propertySchema) errors.push(...validateJson(propertySchema, item, child));
      else if (s.additionalProperties === false)
        errors.push(`${child}: is not an allowed property`);
      else if (isSchema(s.additionalProperties)) {
        errors.push(...validateJson(s.additionalProperties as JsonSchema, item, child));
      }
    }
  }
  return errors;
}

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

function typeList(type: unknown): string[] {
  if (typeof type === "string") return [type];
  return Array.isArray(type) ? type.filter((t): t is string => typeof t === "string") : [];
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

function isSchema(value: unknown): boolean {
  return isPlainObject(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
