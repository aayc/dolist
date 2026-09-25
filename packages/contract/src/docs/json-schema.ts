/**
 * JSON Schema documents for non-TypeScript clients (the iPhone app): every named wire schema as
 * `$defs` of `wire.schema.json`, and the route table as `routes.json` referencing them.
 */
import { API_VERSION } from "@ddl/core";
import { z } from "zod";
import { namedWireSchemas } from "../wire/registry";
import {
  COMMON_API_ERRORS,
  listOperations,
  type ResponseSpec,
  ROUTE_AUTH_DESCRIPTIONS,
} from "../wire/routes";

type JsonObject = Record<string, unknown>;

export const WIRE_SCHEMA_FILE = "wire.schema.json";
export const ROUTES_FILE = "routes.json";
const DRAFT = "https://json-schema.org/draft/2020-12/schema";

function withoutMeta(schema: JsonObject): JsonObject {
  const { $schema: _schema, $id: _id, ...rest } = schema;
  return rest;
}

/** All named wire schemas as one bundle; `$ref`s point into its own `$defs`. */
export function buildWireJsonSchema(): JsonObject {
  const registry = z.registry<{ id: string }>();
  for (const { id, schema } of namedWireSchemas) registry.add(schema, { id });
  const { schemas } = z.toJSONSchema(registry, {
    target: "draft-2020-12",
    uri: (id) => `#/$defs/${id}`,
  });
  const $defs: JsonObject = {};
  for (const { id } of namedWireSchemas) $defs[id] = withoutMeta(schemas[id] as JsonObject);
  return {
    $schema: DRAFT,
    $id: `urn:daily-do-list:wire:v${API_VERSION}`,
    title: "Daily Do List wire protocol",
    description:
      "Every REST body and WebSocket message exchanged with the daemon. Requests reject unknown keys; responses and events may gain keys (clients must ignore them).",
    "x-api-version": API_VERSION,
    $defs,
  };
}

function responseDoc(spec: ResponseSpec, ref: (schema: z.ZodType) => unknown): JsonObject {
  if (spec.kind === "binary") {
    return { description: spec.description, content: "binary" };
  }
  if (spec.kind === "empty") {
    return { description: spec.description, content: "none" };
  }
  return {
    description: spec.description,
    ...(spec.kind === "error" ? { codes: [...spec.codes] } : {}),
    schema: ref(spec.schema),
  };
}

/** The route table with parameters, queries, bodies and per-status responses. */
export function buildRoutesDocument(): JsonObject {
  const wireIds = new Map(namedWireSchemas.map(({ id, schema }) => [schema, id]));
  const registry = z.registry<{ id: string }>();
  for (const { id, schema } of namedWireSchemas) registry.add(schema, { id });
  const local = new Map<z.ZodType, string>();
  const register = (schema: z.ZodType, id: string): string => {
    if (!wireIds.has(schema) && !local.has(schema)) {
      local.set(schema, id);
      registry.add(schema, { id });
    }
    return wireIds.get(schema) ?? local.get(schema)!;
  };

  const operations = listOperations();
  for (const { name, method, route, operation } of operations) {
    if (route.params) register(route.params, `${name}.params`);
    if (operation.query) register(operation.query, `${name}.${method}.query`);
    if (operation.body) register(operation.body, `${name}.${method}.body`);
    for (const [status, response] of Object.entries(operation.responses)) {
      if (response.kind === "json" || response.kind === "error") {
        register(response.schema, `${name}.${method}.${status}`);
      }
    }
  }
  for (const [status, response] of Object.entries(COMMON_API_ERRORS)) {
    register(response.schema, `common.${status}`);
  }

  const localIds = new Set(local.values());
  const { schemas } = z.toJSONSchema(registry, {
    target: "draft-2020-12",
    uri: (id) => (localIds.has(id) ? `#/$defs/${id}` : `${WIRE_SCHEMA_FILE}#/$defs/${id}`),
  });
  const ref = (schema: z.ZodType) => {
    const id = wireIds.get(schema) ?? local.get(schema)!;
    return { $ref: localIds.has(id) ? `#/$defs/${id}` : `${WIRE_SCHEMA_FILE}#/$defs/${id}` };
  };

  const routes: JsonObject = {};
  for (const { name, method, route, operation } of operations) {
    routes[name] ??= {
      path: route.path,
      auth: route.auth,
      ...(route.params ? { params: ref(route.params) } : {}),
      methods: {},
      ...(route.websocket
        ? {
            websocket: { server: ref(route.websocket.server), client: ref(route.websocket.client) },
          }
        : {}),
    };
    const entry = routes[name] as { methods: JsonObject };
    entry.methods[method] = {
      summary: operation.summary,
      ...(operation.query ? { query: ref(operation.query) } : {}),
      ...(operation.body ? { body: ref(operation.body) } : {}),
      responses: Object.fromEntries(
        Object.entries(operation.responses).map(([status, response]) => [
          status,
          responseDoc(response, ref),
        ]),
      ),
    };
  }

  const $defs: JsonObject = {};
  for (const id of [...localIds].sort()) $defs[id] = withoutMeta(schemas[id] as JsonObject);
  return {
    $schema: DRAFT,
    $id: `urn:daily-do-list:routes:v${API_VERSION}`,
    title: "Daily Do List REST routes",
    description:
      "Path patterns use `:name` for one segment and `*` for the rest (a percent-encoded vault path). Every `/api/*` route (auth `bearer` or `pairing_code`) may also answer the `common` errors unless it declares that status itself.",
    "x-api-version": API_VERSION,
    auth: ROUTE_AUTH_DESCRIPTIONS,
    common: Object.fromEntries(
      Object.entries(COMMON_API_ERRORS).map(([status, response]) => [
        status,
        responseDoc(response, ref),
      ]),
    ),
    routes,
    $defs,
  };
}
