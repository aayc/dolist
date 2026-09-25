import type { ApiErrorBody, ApiErrorCode, Logger } from "@ddl/core";
import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { SettingsValidationError } from "./settings-schema";

/** An error with a precise HTTP mapping. `details` are merged into the JSON body. */
export class ApiError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: ApiErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    status: ContentfulStatusCode,
    code: ApiErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Errors thrown by the storage provider and the agent runtime, matched by name: the daemon's null
 * runtime and @ddl/agent each define an `AgentUnavailableError`.
 */
const NAMED_ERRORS = new Map<string, { status: ContentfulStatusCode; code: ApiErrorCode }>([
  ["InvalidPathError", { status: 400, code: "invalid_path" }],
  ["RoutineInputError", { status: 400, code: "invalid_request" }],
  ["NotFoundError", { status: 404, code: "not_found" }],
  ["UnknownThreadError", { status: 404, code: "not_found" }],
  ["UnknownRoutineError", { status: 404, code: "not_found" }],
  ["ConflictError", { status: 409, code: "conflict" }],
  ["RoutineConflictError", { status: 409, code: "conflict" }],
  ["AgentUnavailableError", { status: 503, code: "agent_unavailable" }],
]);

export function errorBody(code: ApiErrorCode, message?: string): ApiErrorBody {
  return message === undefined ? { error: code } : { error: code, message };
}

export function createErrorHandler(logger: Logger): ErrorHandler {
  return (error, c) => {
    const apiError = toApiError(error);
    if (apiError.code === "agent_unavailable") {
      // A state (the agent is off or runs on another device), not a failure.
      logger.debug("Agent unavailable for request", {
        method: c.req.method,
        path: c.req.path,
      });
    } else if (apiError.status >= 500) {
      logger.error("Request failed", {
        method: c.req.method,
        path: c.req.path,
        error: errorMessage(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
    return c.json(
      { ...apiError.details, ...errorBody(apiError.code, apiError.message) },
      apiError.status,
    );
  };
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof HTTPException) {
    const code = error.status === 413 ? "payload_too_large" : "http_error";
    return new ApiError(error.status, code, error.message || "Request failed");
  }
  if (error instanceof SettingsValidationError) {
    return new ApiError(400, "invalid_request", error.message);
  }
  const named = error instanceof Error ? NAMED_ERRORS.get(error.name) : undefined;
  if (named) return new ApiError(named.status, named.code, errorMessage(error));
  return new ApiError(500, "internal_error", "Internal server error");
}

export function isNamedError(error: unknown, name: string): error is Error {
  return error instanceof Error && error.name === name;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
