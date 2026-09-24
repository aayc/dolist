/**
 * Validates tool arguments against the JSON Schema subset our tools use (object/array/string/
 * number/integer/boolean/null, enum, const, required, additionalProperties, items, min/max bounds,
 * anyOf/oneOf, nullable). Harnesses without their own validation check arguments with it before
 * the safety gate or the tool see them.
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

export function typeList(type: unknown): string[] {
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

export function isSchema(value: unknown): boolean {
  return isPlainObject(value);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
