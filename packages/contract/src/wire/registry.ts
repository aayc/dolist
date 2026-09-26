import { z } from "zod";

export interface WireSchemaMeta {
  /** Stable name used for JSON Schema `$defs`, docs anchors and fixture file names. */
  id: string;
}

/** Every named wire schema. Drives the JSON Schema export and the protocol reference. */
export const wireRegistry = z.registry<WireSchemaMeta>();

/** Named schemas in declaration order. */
export const namedWireSchemas: Array<{ id: string; schema: z.ZodType }> = [];

/** A named schema's type carries its id, so `WIRE_SCHEMAS` can be typed from the exports. */
export type Named<Id extends string, T> = T & { readonly "~wireId": Id };

/** Registers `schema` under `id` with a human description (shown in JSON Schema and docs). */
export function named<Id extends string, T extends z.ZodType>(
  id: Id,
  description: string,
  schema: T,
): Named<Id, T> {
  const described = schema.describe(description);
  wireRegistry.add(described, { id });
  namedWireSchemas.push({ id, schema: described });
  return described as Named<Id, T>;
}
