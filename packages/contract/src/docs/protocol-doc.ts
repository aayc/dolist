/** Renders the generated part of docs/PROTOCOL.md from the contract. */
import { API_VERSION } from "@ddl/core";
import { API_ERROR_CODE_DESCRIPTIONS, API_ERROR_CODES } from "../wire/errors";
import { ClientEventSchema, ServerEventSchema } from "../wire/events";
import { namedWireSchemas, wireRegistry } from "../wire/registry";
import { COMMON_API_ERRORS, listOperations, type ResponseSpec } from "../wire/routes";
import { buildRoutesDocument, buildWireJsonSchema } from "./json-schema";

export const GENERATED_BEGIN =
  "<!-- BEGIN GENERATED REFERENCE (pnpm --filter @ddl/contract generate); edits below are overwritten -->";
export const GENERATED_END = "<!-- END GENERATED REFERENCE -->";

type Json = Record<string, unknown>;

const anchor = (id: string) => `#${id.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
const link = (id: string) => `[\`${id}\`](${anchor(id)})`;
const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");

function refName(ref: string): string {
  return ref.slice(ref.lastIndexOf("/") + 1);
}

function range(min: unknown, max: unknown, unit = ""): string {
  const safe = (n: unknown) => typeof n === "number" && Math.abs(n) < Number.MAX_SAFE_INTEGER;
  if (safe(min) && safe(max)) return `${min}–${max}${unit}`;
  if (safe(min)) return `≥ ${min}${unit}`;
  if (safe(max)) return `≤ ${max}${unit}`;
  return "";
}

/** A compact, human type for a JSON Schema node; named schemas become links. */
function typeOf(schema: Json, defs: Json): string {
  if (typeof schema.$ref === "string") {
    const name = refName(schema.$ref);
    return name in defs && wireIds.has(name) ? link(name) : typeOf(defs[name] as Json, defs);
  }
  if ("const" in schema) return `\`${JSON.stringify(schema.const)}\``;
  if (Array.isArray(schema.enum))
    return schema.enum.map((v) => `\`${JSON.stringify(v)}\``).join(" | ");
  const options = (schema.anyOf ?? schema.oneOf) as Json[] | undefined;
  if (options) return options.map((option) => typeOf(option, defs)).join(" | ");
  if (Array.isArray(schema.type)) {
    return schema.type.map((type) => typeOf({ ...schema, type }, defs)).join(" | ");
  }
  switch (schema.type) {
    case "array":
      return `${typeOf((schema.items as Json) ?? {}, defs)}[]`;
    case "string": {
      const details = [
        schema.format === undefined ? "" : String(schema.format),
        typeof schema.pattern === "string" && schema.format === undefined
          ? `\`${schema.pattern}\``
          : "",
        range(schema.minLength, schema.maxLength, " chars"),
      ].filter(Boolean);
      return details.length > 0 ? `string (${details.join(", ")})` : "string";
    }
    case "integer":
    case "number": {
      const bounds = range(schema.minimum, schema.maximum);
      return bounds ? `${schema.type} (${bounds})` : String(schema.type);
    }
    case "null":
      return "`null`";
    case "boolean":
      return "boolean";
    case "object":
      return "object";
    default:
      return "any JSON";
  }
}

const wireIds = new Set(namedWireSchemas.map((entry) => entry.id));

function fieldTable(schema: Json, defs: Json): string[] {
  const properties = (schema.properties ?? {}) as Record<string, Json>;
  const required = new Set((schema.required ?? []) as string[]);
  const lines = ["| Field | Type | Required | Description |", "| --- | --- | --- | --- |"];
  for (const [key, property] of Object.entries(properties)) {
    const description = typeof property.description === "string" ? property.description : "";
    lines.push(
      `| \`${key}\` | ${cell(typeOf(property, defs))} | ${required.has(key) ? "yes" : "no"} | ${cell(description)} |`,
    );
  }
  const extra = schema.additionalProperties;
  lines.push(
    "",
    extra === false
      ? "_Strict: unknown keys are rejected._"
      : "_Tolerant: clients must ignore keys they don't know._",
  );
  return lines;
}

function responseLine(status: string, spec: ResponseSpec): string {
  if (spec.kind === "binary") return `  - \`${status}\` bytes — ${spec.description}`;
  const id = wireRegistry.get(spec.schema)?.id;
  const schema = id ? link(id) : "see `routes.json`";
  const codes = spec.kind === "error" ? ` ${spec.codes.map((c) => `\`${c}\``).join(", ")}` : "";
  return `  - \`${status}\` ${schema}${codes} — ${spec.description}`;
}

export function renderProtocolReference(): string {
  const wire = buildWireJsonSchema();
  const defs = wire.$defs as Json;
  const routes = buildRoutesDocument();
  const operations = listOperations();
  const out: string[] = [
    GENERATED_BEGIN,
    "",
    "## Reference",
    "",
    `API version: **${API_VERSION}**. Machine-readable: \`packages/contract/schema/wire.schema.json\` (every schema) and \`packages/contract/schema/routes.json\` (every route).`,
    "",
    "### REST routes",
    "",
    "| Route | Method | Path | Body | Success |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const { name, method, route, operation } of operations) {
    const body = operation.body ? link(wireRegistry.get(operation.body)!.id) : "—";
    const success = Object.entries(operation.responses)
      .filter(([status]) => Number(status) < 300)
      .map(([status, spec]) =>
        spec.kind === "binary"
          ? `${status} bytes`
          : `${status} ${link(wireRegistry.get(spec.schema)!.id)}`,
      )
      .join(", ");
    out.push(`| \`${name}\` | ${method} | \`${route.path}\` | ${body} | ${success || "—"} |`);
  }
  out.push(
    "",
    `Every \`/api/*\` route can also answer ${Object.entries(COMMON_API_ERRORS)
      .map(([status, spec]) => `${status} (${spec.codes.map((c) => `\`${c}\``).join(", ")})`)
      .join(", ")}. Methods a route doesn't list answer 404 \`not_found\`.`,
    "",
  );

  let current = "";
  for (const { name, method, route, operation } of operations) {
    if (name !== current) {
      current = name;
      out.push(`#### \`${name}\` — \`${route.path}\``, "");
      const params = route.params ? Object.keys(route.params.shape) : [];
      if (params.length > 0) {
        const paramDoc = (routes.$defs as Json)[`${name}.params`] as Json | undefined;
        const props = (paramDoc?.properties ?? {}) as Record<string, Json>;
        for (const param of params) {
          const prop = props[param] ?? {};
          out.push(
            `- Path parameter \`${param}\`: ${typeOf(prop, defs)}${prop.description ? ` — ${prop.description}` : ""}`,
          );
        }
        out.push("");
      }
    }
    out.push(`**${method}** — ${operation.summary}`, "");
    if (operation.query) {
      const shape = operation.query.shape as Record<string, { description?: string }>;
      for (const [key, value] of Object.entries(shape)) {
        out.push(`- Query \`${key}\`${value.description ? `: ${value.description}` : ""}`);
      }
    }
    if (operation.body) out.push(`- Body: ${link(wireRegistry.get(operation.body)!.id)}`);
    out.push("- Responses:");
    for (const [status, spec] of Object.entries(operation.responses))
      out.push(responseLine(status, spec));
    out.push("");
  }

  out.push("### Error codes", "", "| Code | Meaning |", "| --- | --- |");
  for (const code of API_ERROR_CODES)
    out.push(`| \`${code}\` | ${cell(API_ERROR_CODE_DESCRIPTIONS[code])} |`);

  out.push(
    "",
    "### WebSocket `/ws`",
    "",
    "Server → client ([`ServerEvent`](#serverevent)); clients ignore types they don't know:",
    "",
    "| `type` | Schema | Description |",
    "| --- | --- | --- |",
  );
  for (const option of ServerEventSchema.options) {
    const id = wireRegistry.get(option)!.id;
    out.push(
      `| \`${option.shape.type.value}\` | ${link(id)} | ${cell(option.description ?? "")} |`,
    );
  }
  out.push(
    "",
    "Client → server ([`ClientEvent`](#clientevent)); anything else is answered with an `error` event:",
    "",
    "| `type` | Schema | Description |",
    "| --- | --- | --- |",
  );
  for (const option of ClientEventSchema.options) {
    const id = wireRegistry.get(option)!.id;
    out.push(
      `| \`${option.shape.type.value}\` | ${link(id)} | ${cell(option.description ?? "")} |`,
    );
  }

  out.push("", "### Schemas", "");
  for (const { id } of namedWireSchemas) {
    const schema = defs[id] as Json;
    out.push(`#### ${id}`, "");
    if (typeof schema.description === "string") out.push(schema.description, "");
    if (schema.type === "object") out.push(...fieldTable(schema, defs));
    else out.push(`Type: ${typeOf({ ...schema, description: undefined }, defs)}`);
    out.push("");
  }
  out.push(GENERATED_END);
  return `${out.join("\n")}\n`;
}

/** `doc` with its generated section replaced (appended when missing). */
export function replaceGeneratedSection(doc: string, reference: string): string {
  const begin = doc.indexOf(GENERATED_BEGIN);
  const end = doc.indexOf(GENERATED_END);
  if (begin === -1 || end === -1) return `${doc.trimEnd()}\n\n${reference}`;
  return `${doc.slice(0, begin)}${reference}${doc.slice(end + GENERATED_END.length).replace(/^\n/, "")}`;
}

/** The generated section currently in `doc`, or null. */
export function extractGeneratedSection(doc: string): string | null {
  const begin = doc.indexOf(GENERATED_BEGIN);
  const end = doc.indexOf(GENERATED_END);
  if (begin === -1 || end === -1) return null;
  return `${doc.slice(begin, end + GENERATED_END.length)}\n`;
}
