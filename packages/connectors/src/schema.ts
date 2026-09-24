/**
 * Normalizes an MCP tool `inputSchema` into parameters OpenAI-compatible function calling accepts:
 * an object root with `properties`, `required` limited to declared properties, no root `$schema` /
 * `$id`, and top-level `allOf`/`anyOf`/`oneOf` (rejected by OpenAI) folded into the root properties.
 * Nested schemas keep their content but are copied as plain JSON (no `__proto__` keys, cycles or
 * non-JSON values).
 *
 * Adapted from Hermes Agent (MIT): tools/mcp_tool_schema.py (`_repair_object_shape`).
 */
import type { JsonSchema } from "@ddl/core";
import { defineOwn, isPlainObject, type PlainObject } from "./util";

const COMBINATORS = ["allOf", "anyOf", "oneOf"] as const;
/** Root keywords OpenAI rejects for function parameters (or that are meaningless there). */
const DROPPED_ROOT_KEYS = new Set([
  "__proto__",
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
  const copyBudget = { nodes: MAX_COPIED_NODES };
  addProperties(properties, input.properties, copyBudget);
  const required = new Set(stringList(input.required));
  for (const combinator of COMBINATORS) {
    const branches: unknown = input[combinator];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches as unknown[]) {
      if (!isPlainObject(branch)) continue;
      addProperties(properties, branch.properties, copyBudget);
      // Only `allOf` branches are all mandatory; `anyOf`/`oneOf` requirements become optional.
      if (combinator === "allOf")
        for (const name of stringList(branch.required)) required.add(name);
    }
  }

  const schema: JsonSchema = { type: "object", properties };
  const kept = [...required].filter((name) => Object.hasOwn(properties, name));
  if (kept.length > 0) schema.required = kept;
  for (const [key, value] of Object.entries(input)) {
    if (DROPPED_ROOT_KEYS.has(key)) continue;
    // Annotations of the wrong type make providers reject the whole request.
    if ((key === "description" || key === "title") && typeof value !== "string") continue;
    const copy = jsonOnly(value, copyBudget);
    if (copy !== undefined) defineOwn(schema, key, copy);
  }
  return schema;
}

const MAX_COPIED_DEPTH = 64;
const MAX_COPIED_NODES = 100_000;

/**
 * A JSON-only copy for downstream consumers that assign keys naively: `__proto__` keys, non-JSON
 * values, cycles and anything beyond the depth/size budget are dropped.
 */
function jsonOnly(
  value: unknown,
  budget: { nodes: number },
  depth = 0,
  ancestors: object[] = [],
): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value + 0 : undefined;
  if (typeof value !== "object" || depth >= MAX_COPIED_DEPTH || --budget.nodes < 0)
    return undefined;
  if (ancestors.includes(value)) return undefined;
  const path = [...ancestors, value];
  if (Array.isArray(value)) {
    return (value as unknown[]).map((item) => jsonOnly(item, budget, depth + 1, path) ?? null);
  }
  if (!isPlainObject(value)) return undefined;
  const out: PlainObject = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "__proto__") continue;
    const copy = jsonOnly(item, budget, depth + 1, path);
    if (copy !== undefined) defineOwn(out, key, copy);
  }
  return out;
}

function describesObject(type: unknown): boolean {
  if (type === undefined || type === "object") return true;
  return Array.isArray(type) && type.includes("object");
}

function addProperties(target: PlainObject, source: unknown, budget: { nodes: number }): void {
  if (!isPlainObject(source)) return;
  for (const [name, schema] of Object.entries(source)) {
    if (name === "__proto__" || Object.hasOwn(target, name) || schema === false) continue;
    const copy = isPlainObject(schema) ? jsonOnly(schema, budget) : undefined;
    defineOwn(target, name, copy ?? {});
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? (value as unknown[]).filter((item): item is string => typeof item === "string")
    : [];
}
