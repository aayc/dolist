/**
 * Normalizes an MCP tool `inputSchema` into parameters OpenAI-compatible function calling accepts:
 * an object root with `properties`, `required` limited to declared properties, no root `$schema` /
 * `$id`, and top-level `allOf`/`anyOf`/`oneOf` (rejected by OpenAI) folded into the root properties.
 * Nested schemas are passed through untouched.
 *
 * Adapted from Hermes Agent (MIT): tools/mcp_tool_schema.py (`_repair_object_shape`).
 */
import type { JsonSchema } from "@ddl/core";
import { defineOwn, isPlainObject, type PlainObject } from "./util";

const COMBINATORS = ["allOf", "anyOf", "oneOf"] as const;
/** Root keywords OpenAI rejects for function parameters (or that are meaningless there). */
const DROPPED_ROOT_KEYS = new Set([
  "$schema",
  "$id",
  ...COMBINATORS,
  "not",
  "enum",
  "const",
  "type",
  "properties",
  "required",
]);

export function normalizeInputSchema(input: unknown): JsonSchema {
  if (!isPlainObject(input)) return { type: "object", properties: {} };
  if (!describesObject(input.type)) {
    // Tool arguments are always an object; a non-object root can't be represented.
    return typeof input.description === "string"
      ? { type: "object", properties: {}, description: input.description }
      : { type: "object", properties: {} };
  }

  const properties: PlainObject = {};
  addProperties(properties, input.properties);
  const required = new Set(stringList(input.required));
  for (const combinator of COMBINATORS) {
    const branches: unknown = input[combinator];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches as unknown[]) {
      if (!isPlainObject(branch)) continue;
      addProperties(properties, branch.properties);
      // Only `allOf` branches are all mandatory; `anyOf`/`oneOf` requirements become optional.
      if (combinator === "allOf")
        for (const name of stringList(branch.required)) required.add(name);
    }
  }

  const schema: JsonSchema = { type: "object", properties };
  const kept = [...required].filter((name) => Object.hasOwn(properties, name));
  if (kept.length > 0) schema.required = kept;
  for (const [key, value] of Object.entries(input)) {
    if (!DROPPED_ROOT_KEYS.has(key)) defineOwn(schema, key, value);
  }
  return schema;
}

function describesObject(type: unknown): boolean {
  if (type === undefined || type === "object") return true;
  return Array.isArray(type) && type.includes("object");
}

function addProperties(target: PlainObject, source: unknown): void {
  if (!isPlainObject(source)) return;
  for (const [name, schema] of Object.entries(source)) {
    if (Object.hasOwn(target, name) || schema === false) continue;
    defineOwn(target, name, isPlainObject(schema) ? schema : {});
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? (value as unknown[]).filter((item): item is string => typeof item === "string")
    : [];
}
