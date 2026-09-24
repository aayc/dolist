import type { NoteResponse } from "@ddl/core";

export class HttpError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
}

/** 409 from a note write whose `baseVersion` is stale. `current` is null if the note was deleted. */
export class ConflictError extends HttpError {
  readonly current: NoteResponse | null;

  constructor(current: NoteResponse | null) {
    super(409, "The note changed on disk", { error: "conflict", current });
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
