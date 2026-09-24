import { CLIENT_ID_HEADER } from "@ddl/core";
import type { Context } from "hono";
import { z } from "zod";
import { ApiError } from "./errors";
import type { WriteSource } from "./write-tracker";

const ID_RE = /^[A-Za-z0-9_.:-]{1,200}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export async function readJson<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, "invalid_json", "Request body must be valid JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ApiError(400, "invalid_request", z.prettifyError(parsed.error));
  return parsed.data;
}

/** A route parameter holding a runtime-issued identifier (thread, approval, artifact). */
export function idParam(c: Context, name: string): string {
  const value = c.req.param(name);
  if (!value || !ID_RE.test(value)) throw new ApiError(400, "invalid_request", `Invalid ${name}`);
  return value;
}

export function isValidClientId(value: unknown): value is string {
  return typeof value === "string" && CLIENT_ID_RE.test(value);
}

/** Attribution for writes made by this request, so WebSocket clients can skip their own echoes. */
export function clientWriteSource(c: Context): WriteSource {
  const clientId = c.req.header(CLIENT_ID_HEADER);
  return isValidClientId(clientId) ? { origin: "client", clientId } : { origin: "client" };
}

export function isTruthyFlag(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "yes";
}
