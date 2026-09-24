import type { ServerEvent } from "@ddl/core";

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasString(obj: Json, key: string): boolean {
  return typeof obj[key] === "string";
}

const validators: Record<ServerEvent["type"], (event: Json) => boolean> = {
  hello: () => true,
  error: (e) => hasString(e, "message"),
  "vault.changed": (e) => Array.isArray(e.changes) && hasString(e, "origin"),
  "task.records": (e) => hasString(e, "notePath") && Array.isArray(e.records),
  "task.record": (e) => isObject(e.record) && hasString(e.record, "taskId"),
  "thread.upsert": (e) => isObject(e.thread) && hasString(e.thread, "id"),
  "thread.message": (e) =>
    hasString(e, "threadId") && isObject(e.message) && hasString(e.message, "id"),
  "thread.delta": (e) =>
    hasString(e, "threadId") && hasString(e, "messageId") && hasString(e, "delta"),
  "approval.upsert": (e) => isObject(e.approval) && hasString(e.approval, "id"),
  "agent.status": (e) => isObject(e.status),
  "surface.frame": (e) =>
    hasString(e, "threadId") &&
    hasString(e, "data") &&
    (e.surface === "browser" || e.surface === "computer"),
  "settings.changed": (e) => isObject(e.settings),
};

/** Validates the shape of a daemon push event; unknown or malformed events are dropped. */
export function parseServerEvent(raw: unknown): ServerEvent | null {
  if (!isObject(raw) || typeof raw.type !== "string") return null;
  const validate = validators[raw.type as ServerEvent["type"]];
  if (!validate?.(raw)) return null;
  return raw as unknown as ServerEvent;
}
