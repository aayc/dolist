import { z } from "zod";

const cache = new WeakMap<z.ZodType, z.ZodType>();

/**
 * The same schema with every object made strict, recursively. Clients parse responses and events
 * tolerantly; conformance tests parse them with `exact(schema)` so a producer (daemon, runtime, the
 * in-browser mock) can't emit a key the contract doesn't declare.
 */
export function exact<T extends z.ZodType>(schema: T): T {
  return convert(schema) as T;
}

function convert(schema: z.ZodType): z.ZodType {
  const cached = cache.get(schema);
  if (cached) return cached;
  const result = build(schema);
  cache.set(schema, result);
  return result;
}

function build(schema: z.ZodType): z.ZodType {
  const def = schema.def;
  switch (def.type) {
    case "object": {
      const shape: Record<string, z.ZodType> = {};
      for (const [key, value] of Object.entries((schema as z.ZodObject).shape)) {
        shape[key] = convert(value as z.ZodType);
      }
      return z.strictObject(shape);
    }
    case "array":
      return z.array(convert((schema as z.ZodArray<z.ZodType>).element));
    case "optional":
      return convert((schema as z.ZodOptional<z.ZodType>).unwrap()).optional();
    case "nullable":
      return convert((schema as z.ZodNullable<z.ZodType>).unwrap()).nullable();
    case "union": {
      const options = (schema as z.ZodUnion<z.ZodType[]>).options.map(convert);
      const discriminator = (def as { discriminator?: string }).discriminator;
      return discriminator === undefined
        ? z.union(options as [z.ZodType, ...z.ZodType[]])
        : z.discriminatedUnion(discriminator, options as [z.ZodObject, ...z.ZodObject[]]);
    }
    case "string":
    case "number":
    case "boolean":
    case "enum":
    case "literal":
    case "template_literal":
    case "unknown":
    case "null":
      return schema;
    default:
      throw new Error(`exact(): unsupported schema type "${def.type}"`);
  }
}
