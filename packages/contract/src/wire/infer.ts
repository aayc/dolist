import type { z } from "zod";
import type { WIRE_SCHEMAS, WireSchemaName } from "./catalog";

/** Drops index signatures (tolerant objects parse as `{ …; [k: string]: unknown }`), recursively. */
export type WithoutIndexSignatures<T> = T extends readonly (infer E)[]
  ? WithoutIndexSignatures<E>[]
  : T extends object
    ? {
        [K in keyof T as string extends K
          ? never
          : number extends K
            ? never
            : K]: WithoutIndexSignatures<T[K]>;
      }
    : T;

/**
 * The TypeScript type of a named wire schema: its parsed output, minus the index signatures of
 * tolerant objects (a producer may only send the declared keys; see `exact`).
 */
export type WireType<K extends WireSchemaName> = WithoutIndexSignatures<
  z.output<(typeof WIRE_SCHEMAS)[K]>
>;
