import type { NoteResponse } from "@ddl/core";

export class HttpError extends Error {
  readonly status: number;
  readonly body: unknown;
  /** A 429's `Retry-After`, in seconds, when the daemon sent one. */
  readonly retryAfterSeconds: number | undefined;

  constructor(status: number, message: string, body?: unknown, retryAfterSeconds?: number) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * 409 from a note write or rename whose target changed (a `ConflictResponse`). `current` is the
 * note now on disk, or null if it was deleted.
 */
export class ConflictError extends HttpError {
  readonly current: NoteResponse | null;

  constructor(current: NoteResponse | null, body: unknown = { error: "conflict", current }) {
    super(409, "The note changed on disk", body);
    this.name = "ConflictError";
    this.current = current;
  }
}

export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }
}

export function isNotFound(error: unknown): boolean {
  return error instanceof HttpError && error.status === 404;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
