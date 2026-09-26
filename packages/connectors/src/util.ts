/** Small helpers for untrusted, JSON-shaped values (config files, MCP payloads). */

import { compareStrings } from "@ddl/core";

export type PlainObject = Record<string, unknown>;

export function isPlainObject(value: unknown): value is PlainObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

/** Sets an own enumerable property; safe for keys such as `__proto__` that appear in parsed JSON. */
export function defineOwn(target: PlainObject, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** Locale-independent ordering, so sorted output is identical on every machine. */
/** JSON with object keys sorted, for order-insensitive comparisons. */
export function stableStringify(value: unknown): string {
  return (
    JSON.stringify(value, (_key, nested: unknown) =>
      isPlainObject(nested)
        ? Object.fromEntries(Object.entries(nested).sort(([a], [b]) => compareStrings(a, b)))
        : nested,
    ) ?? "undefined"
  );
}
