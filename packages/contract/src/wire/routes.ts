/**
 * The route table: for every entry of `API_ROUTES`, its path pattern, parameters, query, request
 * body and the response of each status it can answer (success and documented errors).
 */
import type { ApiErrorCode, ApiRouteName } from "@ddl/core";
import { z } from "zod";
import { ApprovalStatusSchema } from "./domain";
import {
  ApiErrorBodySchema,
  ApprovalConflictResponseSchema,
  ConflictResponseSchema,
} from "./errors";
import { ClientEventSchema, ServerEventSchema } from "./events";
import { IsoDateSchema, RequestPathSchema, RuntimeIdSchema, WIRE_LIMITS } from "./primitives";
import {
  AgentStatusResponseSchema,
  ApprovalDecisionRequestSchema,
  ApprovalListResponseSchema,
  ApprovalResponseSchema,
  ComputerPermissionsOpenRequestSchema,
  ConnectorsResponseSchema,
  CreateFolderRequestSchema,
  CreateFolderResponseSchema,
  DailyNoteResponseSchema,
  HealthResponseSchema,
  NoteResponseSchema,
  OkResponseSchema,
  PostMessageRequestSchema,
  RenameRequestSchema,
  RenameResponseSchema,
  SearchResponseSchema,
  SetAgentEnabledRequestSchema,
  SetAgentEnabledResponseSchema,
  SettingsResponseSchema,
  SyncStatusResponseSchema,
  TaskRecordsResponseSchema,
  ThreadActionResponseSchema,
  ThreadListResponseSchema,
  ThreadResponseSchema,
  TrashResponseSchema,
  VaultTreeResponseSchema,
  WriteNoteRequestSchema,
  WriteNoteResponseSchema,
} from "./rest";
import { UpdateSettingsRequestSchema } from "./settings";

export type HttpMethod = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";

export interface JsonResponseSpec {
  kind: "json";
  schema: z.ZodType;
  description: string;
}

export interface BinaryResponseSpec {
  kind: "binary";
  description: string;
}

export interface ErrorResponseSpec {
  kind: "error";
  schema: z.ZodType;
  /** The `error` codes this status can carry on this operation. */
  codes: readonly ApiErrorCode[];
  description: string;
}

export type ResponseSpec = JsonResponseSpec | BinaryResponseSpec | ErrorResponseSpec;

export interface OperationSpec {
  summary: string;
  /** Query parameters (strings on the wire). Unknown parameters are ignored. */
  query?: z.ZodObject;
  /** JSON request body (strict: unknown keys are rejected). */
  body?: z.ZodType;
  responses: Readonly<Record<number, ResponseSpec>>;
}

export interface RouteSpec {
  /** Path pattern: `:name` matches one segment, a trailing `*` (named `path`) the rest. */
  path: string;
  params?: z.ZodObject;
  /** `bearer`: `/api/*` auth (token + Host + Origin). `upgrade`: `/ws` (token in `?token=`). */
  auth: "bearer" | "upgrade";
  methods: Partial<Record<HttpMethod, OperationSpec>>;
  websocket?: { server: z.ZodType; client: z.ZodType };
}

const json = (schema: z.ZodType, description: string): JsonResponseSpec => ({
  kind: "json",
  schema,
  description,
});

const error = (
  codes: readonly ApiErrorCode[],
  description: string,
  schema: z.ZodType = ApiErrorBodySchema,
): ErrorResponseSpec => ({ kind: "error", schema, codes, description });

/** Errors any `/api/*` operation can answer, whatever its own responses list. */
export const COMMON_API_ERRORS = {
  401: error(["unauthorized"], "Missing or invalid bearer token."),
  403: error(["forbidden_host", "forbidden_origin"], "Foreign Host or Origin header."),
  500: error(["internal_error"], "Unexpected daemon failure."),
} as const satisfies Record<number, ErrorResponseSpec>;

/** Errors of every operation that reads a JSON body. */
const BODY_ERRORS = {
  413: error(["payload_too_large"], "Body over 5 MB."),
} as const;

const invalidBody = (extra: readonly ApiErrorCode[] = []) =>
  error(["invalid_json", "invalid_request", ...extra], "Malformed JSON or failed validation.");

const THREAD_ACTION_RESPONSES = {
  200: json(ThreadActionResponseSchema, "The runtime finished the action."),
  202: json(ThreadActionResponseSchema, "Still running in the background (`pending: true`)."),
  400: error(["invalid_request"], "Invalid thread id."),
  404: error(["not_found"], "Unknown thread."),
  500: error(["agent_error", "internal_error"], "The runtime failed the action."),
  503: error(["agent_unavailable"], "The agent can't act right now."),
} as const;

const ThreadIdParams = z.object({ id: RuntimeIdSchema });
const Flag = z.string().optional().describe("`1`, `true` or `yes` = on; anything else = off.");

export const API_CONTRACT = {
  health: {
    path: "/api/health",
    auth: "bearer",
    methods: {
      GET: {
        summary: "Liveness, daemon and API versions.",
        responses: { 200: json(HealthResponseSchema, "Healthy.") },
      },
    },
  },
  tree: {
    path: "/api/vault/tree",
    auth: "bearer",
    methods: {
      GET: {
        summary: "Every visible file and folder.",
        responses: { 200: json(VaultTreeResponseSchema, "The vault tree.") },
      },
    },
  },
  note: {
    path: "/api/notes/*",
    auth: "bearer",
    params: z.object({
      path: RequestPathSchema.describe("Vault path of a text note, each segment percent-encoded."),
    }),
    methods: {
      GET: {
        summary: "Read a note.",
        responses: {
          200: json(NoteResponseSchema, "The note."),
          400: error(["invalid_path"], "Malformed, hidden or non-text path."),
          404: error(["not_found"], "No such note."),
        },
      },
      PUT: {
        summary: "Create or overwrite a note (optimistic concurrency via `baseVersion`).",
        body: WriteNoteRequestSchema,
        responses: {
          200: json(WriteNoteResponseSchema, "Overwritten."),
          201: json(WriteNoteResponseSchema, "Created."),
          400: invalidBody(["invalid_path"]),
          409: error(
            ["conflict"],
            "`baseVersion` is stale (or `null` and the note exists).",
            ConflictResponseSchema,
          ),
          ...BODY_ERRORS,
        },
      },
      DELETE: {
        summary: "Move a note to `.trash/`.",
        responses: {
          200: json(TrashResponseSchema, "Moved to the trash."),
          400: error(["invalid_path"], "Malformed, hidden or non-text path."),
          404: error(["not_found"], "No such note."),
        },
      },
    },
  },
  rename: {
    path: "/api/notes-rename",
    auth: "bearer",
    methods: {
      POST: {
        summary: "Rename or move a note, or a folder with its contents.",
        body: RenameRequestSchema,
        responses: {
          200: json(RenameResponseSchema, "Renamed."),
          400: invalidBody(["invalid_path"]),
          404: error(["not_found"], "The source doesn't exist."),
          409: error(
            ["conflict"],
            "The target exists (a note conflict carries the existing note).",
            z.union([ConflictResponseSchema, ApiErrorBodySchema]),
          ),
          ...BODY_ERRORS,
        },
      },
    },
  },
  folders: {
    path: "/api/folders",
    auth: "bearer",
    methods: {
      POST: {
        summary: "Create a folder (and its parents).",
        body: CreateFolderRequestSchema,
        responses: {
          201: json(CreateFolderResponseSchema, "Created (or already there)."),
          400: invalidBody(["invalid_path"]),
          ...BODY_ERRORS,
        },
      },
      DELETE: {
        summary: "Move a folder and everything in it to `.trash/`.",
        query: z.looseObject({ path: RequestPathSchema.describe("Folder path.") }),
        responses: {
          200: json(TrashResponseSchema, "Moved to the trash."),
          400: error(["invalid_request", "invalid_path"], "Missing, malformed or hidden path."),
          404: error(["not_found"], "No such folder."),
        },
      },
    },
  },
  daily: {
    path: "/api/daily/:date",
    auth: "bearer",
    params: z.object({
      date: z
        .union([z.literal("today"), IsoDateSchema])
        .describe("`today` (the daemon's local date) or YYYY-MM-DD."),
    }),
    methods: {
      GET: {
        summary: "Read a daily note; with `?create=1`, create it from the template if missing.",
        query: z.looseObject({ create: Flag }),
        responses: {
          200: json(DailyNoteResponseSchema, "The daily note (`created` tells whether it's new)."),
          400: error(["invalid_request", "invalid_settings"], "Bad date or unusable settings."),
          404: error(["not_found"], "Missing and `create` was not requested."),
        },
      },
    },
  },
  search: {
    path: "/api/search",
    auth: "bearer",
    methods: {
      GET: {
        summary: "Search note names and contents.",
        query: z.looseObject({
          q: z
            .string()
            .trim()
            .max(WIRE_LIMITS.searchQueryChars)
            .optional()
            .describe("Query; blank = no hits."),
          limit: z
            .string()
            .regex(/^0*[1-9][0-9]*$/, "must be a positive integer")
            .optional()
            .describe(`Maximum hits (default 50, capped at ${WIRE_LIMITS.searchLimit}).`),
        }),
        responses: {
          200: json(SearchResponseSchema, "Hits, best first."),
          400: error(["invalid_request"], "Query too long or bad limit."),
        },
      },
    },
  },
  settings: {
    path: "/api/settings",
    auth: "bearer",
    methods: {
      GET: {
        summary: "The effective settings.",
        responses: { 200: json(SettingsResponseSchema, "Settings.") },
      },
      PUT: {
        summary: "Apply a deep-partial settings patch.",
        body: UpdateSettingsRequestSchema,
        responses: {
          200: json(SettingsResponseSchema, "The new effective settings."),
          400: invalidBody(),
          ...BODY_ERRORS,
        },
      },
      PATCH: {
        summary: "Alias of PUT.",
        body: UpdateSettingsRequestSchema,
        responses: {
          200: json(SettingsResponseSchema, "The new effective settings."),
          400: invalidBody(),
          ...BODY_ERRORS,
        },
      },
    },
  },
  agentStatus: {
    path: "/api/agent/status",
    auth: "bearer",
    methods: {
      GET: {
        summary: "The agent runtime's state.",
        responses: { 200: json(AgentStatusResponseSchema, "Status.") },
      },
    },
  },
  agentEnabled: {
    path: "/api/agent/enabled",
    auth: "bearer",
    methods: {
      PUT: {
        summary: "Pause or resume the agent (persisted as `agent.enabled`).",
        body: SetAgentEnabledRequestSchema,
        responses: {
          200: json(SetAgentEnabledResponseSchema, "The resulting status."),
          400: invalidBody(),
          ...BODY_ERRORS,
        },
      },
      POST: {
        summary: "Alias of PUT.",
        body: SetAgentEnabledRequestSchema,
        responses: {
          200: json(SetAgentEnabledResponseSchema, "The resulting status."),
          400: invalidBody(),
          ...BODY_ERRORS,
        },
      },
    },
  },
  tasks: {
    path: "/api/tasks",
    auth: "bearer",
    methods: {
      GET: {
        summary: "Agent records of a note's tasks.",
        query: z.looseObject({ notePath: RequestPathSchema.describe("The note.") }),
        responses: {
          200: json(TaskRecordsResponseSchema, "Records."),
          400: error(["invalid_request", "invalid_path"], "Missing or invalid note path."),
        },
      },
    },
  },
  threads: {
    path: "/api/threads",
    auth: "bearer",
    methods: {
      GET: {
        summary: "Thread summaries, optionally filtered by note or task (empty = no filter).",
        query: z.looseObject({
          notePath: z.string().max(WIRE_LIMITS.requestPathLength).optional(),
          taskId: z.string().max(WIRE_LIMITS.idLength).optional(),
        }),
        responses: {
          200: json(ThreadListResponseSchema, "Summaries."),
          400: error(["invalid_request", "invalid_path"], "Invalid filter."),
        },
      },
    },
  },
  thread: {
    path: "/api/threads/:id",
    auth: "bearer",
    params: ThreadIdParams,
    methods: {
      GET: {
        summary: "A full thread with its approvals.",
        responses: {
          200: json(ThreadResponseSchema, "The thread."),
          400: error(["invalid_request"], "Invalid thread id."),
          404: error(["not_found"], "Unknown thread."),
        },
      },
    },
  },
  threadMessages: {
    path: "/api/threads/:id/messages",
    auth: "bearer",
    params: ThreadIdParams,
    methods: {
      POST: {
        summary: "Reply in a thread (steers a running subagent or resumes a finished one).",
        body: PostMessageRequestSchema,
        responses: {
          ...THREAD_ACTION_RESPONSES,
          400: invalidBody(),
          ...BODY_ERRORS,
        },
      },
    },
  },
  threadCancel: {
    path: "/api/threads/:id/cancel",
    auth: "bearer",
    params: ThreadIdParams,
    methods: {
      POST: { summary: "Stop the task's agent.", responses: THREAD_ACTION_RESPONSES },
    },
  },
  threadRetry: {
    path: "/api/threads/:id/retry",
    auth: "bearer",
    params: ThreadIdParams,
    methods: {
      POST: { summary: "Run the task again.", responses: THREAD_ACTION_RESPONSES },
    },
  },
  approvals: {
    path: "/api/approvals",
    auth: "bearer",
    methods: {
      GET: {
        summary: "Approval requests, optionally by status.",
        query: z.looseObject({ status: ApprovalStatusSchema.optional() }),
        responses: {
          200: json(ApprovalListResponseSchema, "Approvals."),
          400: error(["invalid_request"], "Unknown status."),
        },
      },
    },
  },
  approval: {
    path: "/api/approvals/:id",
    auth: "bearer",
    params: z.object({ id: RuntimeIdSchema }),
    methods: {
      GET: {
        summary: "One approval request.",
        responses: {
          200: json(ApprovalResponseSchema, "The approval."),
          400: error(["invalid_request"], "Invalid approval id."),
          404: error(["not_found"], "Unknown approval."),
        },
      },
      POST: {
        summary: "Approve or deny a pending request.",
        body: ApprovalDecisionRequestSchema,
        responses: {
          200: json(ApprovalResponseSchema, "The decided approval."),
          400: invalidBody(),
          404: error(["not_found"], "Unknown approval."),
          409: error(
            ["conflict"],
            "Already decided, expired or cancelled (carries its current state).",
            ApprovalConflictResponseSchema,
          ),
          500: error(["agent_error", "internal_error"], "The runtime failed to record it."),
          503: error(["agent_unavailable"], "The approval system is unavailable."),
          ...BODY_ERRORS,
        },
      },
    },
  },
  artifact: {
    path: "/api/artifacts/:threadId/:artifactId",
    auth: "bearer",
    params: z.object({ threadId: RuntimeIdSchema, artifactId: RuntimeIdSchema }),
    methods: {
      GET: {
        summary: "Artifact bytes, sandboxed (`Content-Security-Policy: sandbox`, nosniff).",
        query: z.looseObject({ download: Flag }),
        responses: {
          200: {
            kind: "binary",
            description:
              "The bytes with the artifact's type; active content (HTML, SVG, PDF…) is always an attachment.",
          },
          400: error(["invalid_request"], "Invalid id."),
          404: error(["not_found"], "Unknown artifact."),
        },
      },
    },
  },
  connectors: {
    path: "/api/connectors",
    auth: "bearer",
    methods: {
      GET: {
        summary: "MCP connector states.",
        responses: { 200: json(ConnectorsResponseSchema, "Connectors.") },
      },
    },
  },
  syncStatus: {
    path: "/api/sync/status",
    auth: "bearer",
    methods: {
      GET: {
        summary: "The vault's sync state (and, with the sync service, this device's name).",
        responses: { 200: json(SyncStatusResponseSchema, "Sync status.") },
      },
    },
  },
  computerPermissionsOpen: {
    path: "/api/computer/permissions/open",
    auth: "bearer",
    methods: {
      POST: {
        summary:
          "Open System Settings at a privacy pane computer use needs (Accessibility or Screen Recording).",
        body: ComputerPermissionsOpenRequestSchema,
        responses: {
          200: json(OkResponseSchema, "System Settings opened."),
          400: invalidBody(),
          404: error(["not_found"], "Not a Mac: there is no System Settings to open."),
          500: error(["internal_error"], "System Settings didn't open."),
          ...BODY_ERRORS,
        },
      },
    },
  },
  ws: {
    path: "/ws",
    auth: "upgrade",
    methods: {
      GET: {
        summary:
          "WebSocket upgrade (`?token=`). Rejected upgrades answer 401/403/404 with an empty body.",
        query: z.looseObject({ token: z.string().optional().describe("The bearer token.") }),
        responses: {
          403: error(["forbidden_host"], "Foreign Host header."),
          426: error(["upgrade_required"], "Plain HTTP request without a WebSocket upgrade."),
        },
      },
    },
    websocket: { server: ServerEventSchema, client: ClientEventSchema },
  },
} as const satisfies Record<ApiRouteName, RouteSpec>;

export type ApiContract = typeof API_CONTRACT;

export interface RouteMatch {
  name: ApiRouteName;
  route: RouteSpec;
  /** Decoded path parameters (`path` for the note wildcard). */
  params: Record<string, string>;
}

const compiled = (Object.entries(API_CONTRACT) as Array<[ApiRouteName, RouteSpec]>).map(
  ([name, route]) => {
    const names: string[] = [];
    const source = route.path
      .split("/")
      .map((segment) => {
        if (segment === "*") {
          names.push("path");
          return "(.*)";
        }
        if (segment.startsWith(":")) {
          names.push(segment.slice(1));
          return "([^/]+)";
        }
        return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("/")
      // Like the daemon's router, `/api/notes` itself belongs to `/api/notes/*` (empty path).
      .replace(/\/\(\.\*\)$/, "(?:/(.*))?");
    return { name, route, names, re: new RegExp(`^${source}$`) };
  },
);

/**
 * The route a URL pathname belongs to (method-independent), with decoded parameters; `null` for
 * unknown paths or malformed percent-encoding. Parameters are not validated (see `route.params`).
 */
export function matchRoute(pathname: string): RouteMatch | null {
  for (const { name, route, names, re } of compiled) {
    const match = re.exec(pathname);
    if (!match) continue;
    const params: Record<string, string> = {};
    try {
      names.forEach((param, i) => {
        const raw = match[i + 1] ?? "";
        params[param] =
          param === "path"
            ? raw.split("/").map(decodeURIComponent).join("/")
            : decodeURIComponent(raw);
      });
    } catch {
      return null;
    }
    return { name, route, params };
  }
  return null;
}

/** Every (route, method, operation) triple, in table order. */
export function listOperations(): Array<{
  name: ApiRouteName;
  route: RouteSpec;
  method: HttpMethod;
  operation: OperationSpec;
}> {
  return compiled.flatMap(({ name, route }) =>
    (Object.entries(route.methods) as Array<[HttpMethod, OperationSpec]>).map(
      ([method, operation]) => ({ name, route, method, operation }),
    ),
  );
}
