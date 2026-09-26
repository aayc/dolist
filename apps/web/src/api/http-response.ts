import type { NoteResponse } from "@ddl/core";
import { isRecord } from "@ddl/core";
import { ConflictError, HttpError } from "./errors";

/** `Retry-After` in whole seconds (the daemon sends seconds, never a date). */
function retryAfter(response: Response): number | undefined {
  const seconds = Number(response.headers.get("retry-after"));
  return response.status === 429 && Number.isInteger(seconds) && seconds > 0 ? seconds : undefined;
}

/**
 * A daemon answer's JSON body (undefined for an empty one), or the matching client error: a
 * `ConflictError` for a note conflict, else an `HttpError` carrying the daemon's message and body.
 */
export async function readResponse<T>(response: Response): Promise<T> {
  const text = response.status === 204 ? "" : await response.text();
  let data: unknown;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!response.ok) {
    // Only note conflicts carry `current`; other 409s (e.g. an approval already decided) don't.
    if (response.status === 409 && isRecord(data) && "current" in data) {
      const current = isRecord(data.current) ? (data.current as unknown as NoteResponse) : null;
      throw new ConflictError(current, data);
    }
    const message =
      (isRecord(data) && typeof data.message === "string" && data.message) ||
      (isRecord(data) && typeof data.error === "string" && data.error) ||
      response.statusText ||
      `HTTP ${response.status}`;
    throw new HttpError(response.status, message, data, retryAfter(response));
  }
  return data as T;
}
