/**
 * Normalizes a ToolSpec's JSON Schema into one that both the provider (it is sent verbatim as the
 * function's `parameters`) and Pi's TypeBox validator accept. TypeBox 1.x schemas are plain JSON
 * Schema, so no conversion to TypeBox builders is needed; what needs care is input from connectors
 * (MCP) and hand-written specs: OpenAPI `nullable`, draft-04 booleans, `$ref`s providers reject,
 * invalid regexes (which would make every call of the tool fail validation) and missing roots.
 */
import type { JsonSchema } from "@ddl/core";
import { Compile } from "typebox/compile";

export interface NormalizedToolSchema {
  schema: JsonSchema;
  /** Constructs that were dropped or rewritten, for logs. */
  warnings: string[];
  /** The full schema did not compile; a relaxed top-level schema is used instead. */
  degraded: boolean;
}

export class InvalidToolSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidToolSchemaError";
  }
}

type SchemaObject = Record<string, unknown>;

const DROPPED_KEYWORDS = new Set(["$schema", "$id", "$comment", "nullable"]);
const SUBSCHEMA_MAP_KEYWORDS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
]);
const SUBSCHEMA_KEYWORDS = new Set([
  "additionalProperties",
  "unevaluatedProperties",
  "propertyNames",
  "items",
  "additionalItems",
  "unevaluatedItems",
  "contains",
  "not",
  "if",
  "then",
  "else",
]);
const SUBSCHEMA_ARRAY_KEYWORDS = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);
const RELAXED_PROPERTY_KEYWORDS = ["type", "description", "enum", "const", "default"];

const cache = new WeakMap<object, NormalizedToolSchema>();

export function normalizeToolSchema(input: JsonSchema): NormalizedToolSchema {
  const cached = cache.get(input);
  if (cached) return cached;
  const result = normalizeUncached(input);
  cache.set(input, result);
  return result;
}

function normalizeUncached(input: JsonSchema): NormalizedToolSchema {
  const rootType = input.type;
  if (
    rootType !== undefined &&
    rootType !== "object" &&
    !(Array.isArray(rootType) && rootType.includes("object"))
  ) {
    throw new InvalidToolSchemaError(
      `tool parameters must be an object schema (got type ${JSON.stringify(rootType)})`,
    );
  }
  const ctx: Context = { root: input, warnings: [], refStack: [], keepDefs: false };
  const normalized = normalizeNode(input, ctx, "#");
  const schema: SchemaObject = isRecord(normalized) ? normalized : {};
  if (!ctx.keepDefs) {
    delete schema.$defs;
    delete schema.definitions;
  }
  schema.type = "object";
  if (!isRecord(schema.properties)) schema.properties = {};
  const compileError = compileErrorOf(schema);
  if (compileError === undefined) return { schema, warnings: ctx.warnings, degraded: false };
  ctx.warnings.push(`schema does not compile (${compileError}); using relaxed validation`);
  return { schema: relax(schema), warnings: ctx.warnings, degraded: true };
}

interface Context {
  root: SchemaObject;
  warnings: string[];
  /** `$ref`s currently being inlined, to detect recursion. */
  refStack: string[];
  /** A recursive `$ref` was kept, so root definitions must stay. */
  keepDefs: boolean;
}

function normalizeNode(node: unknown, ctx: Context, path: string): unknown {
  if (typeof node === "boolean") return node;
  if (!isRecord(node)) {
    ctx.warnings.push(`${path}: not a schema, accepting any value`);
    return {};
  }
  if (typeof node.$ref === "string") return normalizeRef(node, node.$ref, ctx, path);

  const out: SchemaObject = {};
  for (const [key, value] of Object.entries(node)) {
    const at = `${path}/${key}`;
    if (DROPPED_KEYWORDS.has(key) || (key === "id" && typeof value === "string")) continue;
    if (SUBSCHEMA_MAP_KEYWORDS.has(key)) {
      if (isRecord(value)) out[key] = normalizeMap(value, ctx, at, key === "patternProperties");
      else ctx.warnings.push(`${at}: expected an object, dropped`);
    } else if (SUBSCHEMA_KEYWORDS.has(key)) {
      out[key] = Array.isArray(value)
        ? value.map((item, i) => normalizeNode(item, ctx, `${at}/${i}`))
        : normalizeNode(value, ctx, at);
    } else if (SUBSCHEMA_ARRAY_KEYWORDS.has(key)) {
      if (Array.isArray(value) && value.length > 0) {
        out[key] = value.map((item, i) => normalizeNode(item, ctx, `${at}/${i}`));
      } else ctx.warnings.push(`${at}: expected a non-empty array, dropped`);
    } else if (key === "pattern") {
      if (typeof value === "string" && isValidPattern(value)) out.pattern = value;
      else ctx.warnings.push(`${at}: invalid regular expression, dropped`);
    } else if (key === "required") {
      if (Array.isArray(value)) {
        out.required = [...new Set(value.filter((v): v is string => typeof v === "string"))];
      } else ctx.warnings.push(`${at}: expected an array, dropped`);
    } else if (key === "enum") {
      if (Array.isArray(value) && value.length > 0) out.enum = value;
      else ctx.warnings.push(`${at}: expected a non-empty array, dropped`);
    } else {
      out[key] = value;
    }
  }
  upgradeDraft4Exclusive(out, "exclusiveMinimum", "minimum");
  upgradeDraft4Exclusive(out, "exclusiveMaximum", "maximum");
  return node.nullable === true ? makeNullable(out) : out;
}

function normalizeMap(map: SchemaObject, ctx: Context, path: string, keysAreRegex: boolean) {
  const out: SchemaObject = {};
  for (const [name, value] of Object.entries(map)) {
    if (keysAreRegex && !isValidPattern(name)) {
      ctx.warnings.push(`${path}: invalid pattern ${JSON.stringify(name)}, dropped`);
      continue;
    }
    out[name] = normalizeNode(value, ctx, `${path}/${escapePointer(name)}`);
  }
  return out;
}

/** Inlines local, non-recursive refs; providers differ widely in `$ref` support. */
function normalizeRef(node: SchemaObject, ref: string, ctx: Context, path: string): unknown {
  const { $ref: _ref, ...rest } = node;
  const siblings = Object.keys(rest).length > 0 ? normalizeNode(rest, ctx, path) : undefined;
  if (ctx.refStack.includes(ref)) {
    ctx.keepDefs = true;
    return isRecord(siblings) ? { ...siblings, $ref: ref } : { $ref: ref };
  }
  const target = ref.startsWith("#") ? resolvePointer(ctx.root, ref) : undefined;
  if (target === undefined) {
    ctx.warnings.push(`${path}: unresolvable $ref ${JSON.stringify(ref)}, accepting any value`);
    return siblings ?? {};
  }
  ctx.refStack.push(ref);
  const resolved = normalizeNode(target, ctx, path);
  ctx.refStack.pop();
  if (!isRecord(resolved))
    return siblings === undefined ? resolved : { allOf: [resolved, siblings] };
  return isRecord(siblings) ? { ...resolved, ...siblings } : resolved;
}

function resolvePointer(root: SchemaObject, ref: string): unknown {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined;
  let current: unknown = root;
  for (const raw of ref.slice(2).split("/")) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
    } catch {
      return undefined;
    }
    if (Array.isArray(current)) current = current[Number(segment)];
    else if (isRecord(current) && Object.hasOwn(current, segment)) current = current[segment];
    else return undefined;
  }
  return current;
}

/** OpenAPI 3.0 `nullable: true` → JSON Schema. */
function makeNullable(schema: SchemaObject): SchemaObject {
  const { type } = schema;
  const withNullEnum = (s: SchemaObject): SchemaObject =>
    Array.isArray(s.enum) && !s.enum.includes(null) ? { ...s, enum: [...s.enum, null] } : s;
  if (typeof type === "string") {
    return type === "null" ? schema : withNullEnum({ ...schema, type: [type, "null"] });
  }
  if (Array.isArray(type)) {
    return type.includes("null") ? schema : withNullEnum({ ...schema, type: [...type, "null"] });
  }
  if (Array.isArray(schema.enum)) return withNullEnum(schema);
  const { description, title, ...rest } = schema;
  return {
    ...(description === undefined ? {} : { description }),
    ...(title === undefined ? {} : { title }),
    anyOf: [rest, { type: "null" }],
  };
}

function upgradeDraft4Exclusive(schema: SchemaObject, exclusiveKey: string, boundKey: string) {
  const flag = schema[exclusiveKey];
  if (typeof flag !== "boolean") return;
  const bound = schema[boundKey];
  if (flag && typeof bound === "number") {
    schema[exclusiveKey] = bound;
    delete schema[boundKey];
  } else {
    delete schema[exclusiveKey];
  }
}

function relax(schema: SchemaObject): SchemaObject {
  const properties: SchemaObject = {};
  for (const [name, value] of Object.entries(
    isRecord(schema.properties) ? schema.properties : {},
  )) {
    const relaxed: SchemaObject = {};
    if (isRecord(value)) {
      for (const key of RELAXED_PROPERTY_KEYWORDS) if (key in value) relaxed[key] = value[key];
    }
    properties[name] = compileErrorOf(relaxed) === undefined ? relaxed : {};
  }
  const out: SchemaObject = { type: "object", properties };
  if (typeof schema.description === "string") out.description = schema.description;
  if (Array.isArray(schema.required)) out.required = schema.required;
  return out;
}

function compileErrorOf(schema: SchemaObject): string | undefined {
  try {
    Compile(schema);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function isValidPattern(pattern: string): boolean {
  try {
    new RegExp(pattern, "u");
    return true;
  } catch {
    return false;
  }
}

function escapePointer(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

function isRecord(value: unknown): value is SchemaObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
