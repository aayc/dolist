import { z } from "zod";
import { ApprovalRequestSchema } from "./domain";
import { named } from "./registry";
import { NoteResponseSchema } from "./rest";

export const API_ERROR_CODES = [
  "invalid_json",
  "invalid_request",
  "invalid_path",
  "invalid_settings",
  "unauthorized",
  "pairing_rejected",
  "forbidden_host",
  "forbidden_origin",
  "not_found",
  "conflict",
  "locked_by_env",
  "payload_too_large",
  "upgrade_required",
  "rate_limited",
  "http_error",
  "agent_error",
  "internal_error",
  "machine_unreachable",
  "agent_unavailable",
] as const;

/** What each code means (rendered into docs/PROTOCOL.md). */
export const API_ERROR_CODE_DESCRIPTIONS: Record<(typeof API_ERROR_CODES)[number], string> = {
  invalid_json: "The body is not JSON.",
  invalid_request: "Body, query or route parameter failed validation (the message says which).",
  invalid_path: "A vault path is malformed, hidden (dot-files, the sidecar) or not a text note.",
  invalid_settings: "The stored settings make the request impossible.",
  unauthorized: "Missing or wrong bearer token.",
  pairing_rejected:
    "The pairing code is wrong, expired or already used (checked here, or by the always-on machine).",
  forbidden_host: "The Host header is not a loopback address of this daemon (DNS rebinding).",
  forbidden_origin: "The Origin header is not allowed (CSRF).",
  not_found: "Unknown route (or method), or the addressed item doesn't exist.",
  conflict: "Stale `baseVersion`, existing target, or an approval that is no longer pending.",
  locked_by_env:
    "The device setting is set by an environment variable (see `lockedByEnv`); change it there.",
  payload_too_large: "Request body over 5 MB.",
  upgrade_required: "`/ws` requested without a WebSocket upgrade.",
  rate_limited: "Too many pairing attempts, or too many pairing codes outstanding; try later.",
  http_error: "Raised by the HTTP framework itself.",
  agent_error: "An agent action failed unexpectedly.",
  internal_error: "Unexpected daemon failure.",
  machine_unreachable: "The always-on machine didn't answer (network, TLS or timeout).",
  agent_unavailable:
    "The agent can't act right now (mode off, missing API key, safety system down).",
};

export const ApiErrorCodeSchema = named(
  "ApiErrorCode",
  "Machine-readable error code. Treat unknown codes like any failure with that HTTP status.",
  z.enum(API_ERROR_CODES),
);

export const ApiErrorBodySchema = named(
  "ApiErrorBody",
  "Body of every error response.",
  z.looseObject({
    error: ApiErrorCodeSchema,
    message: z.string().optional().describe("Human-readable explanation."),
  }),
);

export const ConflictResponseSchema = named(
  "ConflictResponse",
  "409 of a note write or rename whose target changed; `current` is null if the note is gone.",
  z.looseObject({
    error: z.literal("conflict"),
    message: z.string().optional(),
    current: NoteResponseSchema.nullable(),
  }),
);

export const ApprovalConflictResponseSchema = named(
  "ApprovalConflictResponse",
  "409 of an approval decision when the approval is no longer pending.",
  z.looseObject({
    error: z.literal("conflict"),
    message: z.string().optional(),
    approval: ApprovalRequestSchema,
  }),
);
