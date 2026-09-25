import type {
  Logger,
  SyncErrorBody,
  SyncErrorCode,
  SyncLeaseHolder,
  SyncStaleLeaseBody,
} from "@ddl/core";
import type { Context, ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { VaultStateError } from "./store";

/** A request the HTTP layer refuses (validation, auth, limits). */
export class SyncApiError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: SyncErrorCode;
  readonly headers: Record<string, string>;

  constructor(
    status: ContentfulStatusCode,
    code: SyncErrorCode,
    message: string,
    headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "SyncApiError";
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

const STATE_STATUS: Partial<Record<SyncErrorCode, ContentfulStatusCode>> = {
  not_found: 404,
  conflict: 409,
  not_a_file: 409,
  not_a_folder: 409,
  path_blocked: 409,
  lease_held: 409,
  stale_lease: 409,
  quota_exceeded: 413,
};

/** A change to the agent's files not made under the current agent grant from this device. */
export class StaleLeaseRefusal extends Error {
  readonly holder: SyncLeaseHolder | null;

  constructor(holder: SyncLeaseHolder | null) {
    super(
      holder
        ? "Only the device holding the agent lease may change the agent's files, with its current grant's epoch"
        : "Nobody holds the agent lease, so the agent's files can't change",
    );
    this.name = "StaleLeaseRefusal";
    this.holder = holder;
  }
}

export function errorBody(code: SyncErrorCode, message: string): SyncErrorBody {
  return { error: code, message };
}

export function createErrorHandler(logger: Logger): ErrorHandler {
  return (error, c) => {
    if (error instanceof SyncApiError) {
      for (const [name, value] of Object.entries(error.headers)) c.header(name, value);
      return c.json(errorBody(error.code, error.message), error.status);
    }
    if (error instanceof VaultStateError) return stateErrorResponse(c, error);
    if (error instanceof StaleLeaseRefusal) {
      const body: SyncStaleLeaseBody = {
        error: "stale_lease",
        message: error.message,
        currentEpoch: error.holder?.epoch ?? null,
        holder: error.holder,
      };
      return c.json(body, 409);
    }
    if (error instanceof HTTPException) {
      return error.status === 413
        ? c.json(errorBody("payload_too_large", "Request body too large"), 413)
        : c.json(errorBody("invalid_request", error.message || "Bad request"), 400);
    }
    logger.error("Request failed", {
      method: c.req.method,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json(errorBody("internal_error", "Internal server error"), 500);
  };
}

function stateErrorResponse(c: Context, error: VaultStateError): Response {
  const status = STATE_STATUS[error.code] ?? 409;
  const body: Record<string, unknown> = { ...errorBody(error.code, error.message) };
  if (error.currentRev !== undefined) body.currentRev = error.currentRev;
  if (error.holder) body.holder = error.holder;
  return c.json(body, status);
}
