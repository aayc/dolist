import { z } from "zod";

export interface WireSchemaMeta {
  /** Stable name used for JSON Schema `$defs`, docs anchors and fixture file names. */
  id: string;
}

/** Every named wire schema. Drives the JSON Schema export and the protocol reference. */
export const wireRegistry = z.registry<WireSchemaMeta>();

/** Named schemas in declaration order. */
export const namedWireSchemas: Array<{ id: string; schema: z.ZodType }> = [];

/** Registers `schema` under `id` with a human description (shown in JSON Schema and docs). */
export function named<T extends z.ZodType>(id: string, description: string, schema: T): T {
  const described = schema.describe(description);
  wireRegistry.add(described, { id });
  namedWireSchemas.push({ id, schema: described });
  return described;
}
