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
import {
  DeviceVaultRequestSchema,
  DeviceVaultResponseSchema,
  ObsidianImportJobResponseSchema,
  ObsidianImportPreviewRequestSchema,
  ObsidianImportPreviewSchema,
  ObsidianImportRequestSchema,
  ObsidianImportStatusResponseSchema,
} from "./imports";
import { IsoDateSchema, RequestPathSchema, RuntimeIdSchema, WIRE_LIMITS } from "./primitives";
import {
  DeviceSettingsPatchSchema,
  DeviceSettingsResponseSchema,
  DeviceSyncSetupRequestSchema,
  MachinePairRequestSchema,
  MachineStatusResponseSchema,
  PairedDevicesResponseSchema,
  PairingCodeRequestSchema,
  PairingCodeResponseSchema,
  PairRequestSchema,
  PairResponseSchema,
} from "./remote";
import {
  AgentStatusResponseSchema,
  ApprovalDecisionRequestSchema,
  ApprovalListResponseSchema,
  ApprovalResponseSchema,
  ComputerPermissionsOpenRequestSchema,
  ConnectorsResponseSchema,
  CreateFolderRequestSchema,
  CreateFolderResponseSchema,
  CreateRoutineRequestSchema,
  DailyNoteResponseSchema,
  HealthResponseSchema,
  NoteResponseSchema,
  OkResponseSchema,
  PostMessageRequestSchema,
  RenameRequestSchema,
  RenameResponseSchema,
  RoutineListResponseSchema,
  RoutineResponseSchema,
  RoutineRunResponseSchema,
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

/** A success without a body (204). */
export interface EmptyResponseSpec {
  kind: "empty";
  description: string;
}

export interface ErrorResponseSpec {
  kind: "error";
  schema: z.ZodType;
  /** The `error` codes this status can carry on this operation. */
  codes: readonly ApiErrorCode[];
  description: string;
}

export type ResponseSpec =
  | JsonResponseSpec
  | BinaryResponseSpec
  | EmptyResponseSpec
  | ErrorResponseSpec;

/**
 * How a route authenticates. `bearer`: `/api/*` auth (a token, or a remote browser's cookie, +
 * Host + Origin). `pairing_code`: no bearer token; the pairing code in the body is the credential
 * (Host and Origin still checked). `upgrade`: `/ws` (the same credentials; `?token=` on loopback
 * Hosts only).
 */
export type RouteAuth = "bearer" | "pairing_code" | "upgrade";

export const ROUTE_AUTH_DESCRIPTIONS: Record<RouteAuth, string> = {
  bearer:
    "`Authorization: Bearer <token>` (the daemon's own token or a paired app's or daemon's), or on a remote host a paired browser's cookie sent by its own page; plus the Host and Origin checks.",
  pairing_code:
    "No bearer token: the pairing code in the body is the credential (Host and Origin are still checked).",
  upgrade:
    "WebSocket upgrade with a bearer token in the `Authorization` header (`?token=` only on loopback Hosts), or on a remote host a paired browser's cookie with its page's Origin; plus the Host and Origin checks.",
};

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
  auth: RouteAuth;
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

/**
 * Errors any `/api/*` operation can answer, whatever its own responses list. An operation's own
 * entry for a status wins (the `pairing_code` route declares its own 401).
 */
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

const DEVICE_SETTINGS_RESPONSES = {
  200: json(DeviceSettingsResponseSchema, "The device settings now."),
  409: error(["locked_by_env"], "An environment variable sets this field (see `lockedByEnv`)."),
} as const;

/** Routes that reach this machine's folders: a paired device is refused too. */
const THIS_MACHINE_ONLY = {
  403: error(
    ["forbidden_host", "forbidden_origin", "forbidden_device"],
    "Foreign Host or Origin header, or a paired device (only this machine may do this).",
  ),
} as const;

const ThreadIdParams = z.object({ id: RuntimeIdSchema });
const RoutineIdParams = z.object({ id: RuntimeIdSchema });

const ROUTINE_FILE_RESPONSES = {
  200: json(RoutineResponseSchema, "The routine as its file now reads."),
  400: error(["invalid_request"], "Invalid routine id."),
  404: error(["not_found"], "Unknown routine."),
  409: error(["conflict"], "The file changed while it was being written; try again."),
} as const;
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
        summary:
          "Thread summaries, optionally filtered by note, task or routine (empty = no filter).",
        query: z.looseObject({
          notePath: z.string().max(WIRE_LIMITS.requestPathLength).optional(),
          taskId: z.string().max(WIRE_LIMITS.idLength).optional(),
          routineId: z
            .string()
            .max(WIRE_LIMITS.idLength)
            .optional()
            .describe("Only this routine's runs."),
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
  routines: {
    path: "/api/routines",
    auth: "bearer",
    methods: {
      GET: {
        summary: "Every routine with its schedule, next and last run, plus the starter templates.",
        responses: { 200: json(RoutineListResponseSchema, "Routines and templates.") },
      },
      POST: {
        summary: "Create a routine: writes `Routines/<name>.md` (works while the agent is off).",
        body: CreateRoutineRequestSchema,
        responses: {
          201: json(RoutineResponseSchema, "Created."),
          400: invalidBody(["invalid_path"]),
          409: error(["conflict"], "A routine with that name exists."),
          ...BODY_ERRORS,
        },
      },
    },
  },
  routine: {
    path: "/api/routines/:id",
    auth: "bearer",
    params: RoutineIdParams,
    methods: {
      GET: {
        summary: "One routine.",
        responses: {
          200: json(RoutineResponseSchema, "The routine."),
          400: error(["invalid_request"], "Invalid routine id."),
          404: error(["not_found"], "Unknown routine."),
        },
      },
    },
  },
  routineRun: {
    path: "/api/routines/:id/run",
    auth: "bearer",
    params: RoutineIdParams,
    methods: {
      POST: {
        summary: "Run a routine now (counts against its extra runs for today).",
        responses: {
          200: json(RoutineRunResponseSchema, "The run started."),
          400: error(["invalid_request"], "Invalid routine id."),
          404: error(["not_found"], "Unknown routine."),
          409: error(
            ["conflict"],
            "It can't run now: a run is going, it has a problem, or today's extra runs are used up.",
          ),
          503: error(["agent_unavailable"], "The agent can't run here right now."),
        },
      },
    },
  },
  routinePause: {
    path: "/api/routines/:id/pause",
    auth: "bearer",
    params: RoutineIdParams,
    methods: {
      POST: {
        summary: "Pause a routine: sets `paused: true` in its file (works while the agent is off).",
        responses: ROUTINE_FILE_RESPONSES,
      },
    },
  },
  routineResume: {
    path: "/api/routines/:id/resume",
    auth: "bearer",
    params: RoutineIdParams,
    methods: {
      POST: {
        summary: "Resume a routine: sets `paused: false` in its file; it runs from its next slot.",
        responses: ROUTINE_FILE_RESPONSES,
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
  device: {
    path: "/api/device",
    auth: "bearer",
    methods: {
      GET: {
        summary: "This daemon's device-local settings (name, placement, remote hosts, sync).",
        responses: { 200: json(DeviceSettingsResponseSchema, "The device settings.") },
      },
      PATCH: {
        summary: "Change the device's name, placement or remote hosts; applies live.",
        body: DeviceSettingsPatchSchema,
        responses: { ...DEVICE_SETTINGS_RESPONSES, 400: invalidBody(), ...BODY_ERRORS },
      },
    },
  },
  deviceSync: {
    path: "/api/device/sync",
    auth: "bearer",
    methods: {
      PUT: {
        summary:
          "Sync this vault with the sync service (the token is stored 0600 in `$DDL_HOME`, never returned).",
        body: DeviceSyncSetupRequestSchema,
        responses: { ...DEVICE_SETTINGS_RESPONSES, 400: invalidBody(), ...BODY_ERRORS },
      },
      DELETE: {
        summary: "Stop syncing with the sync service and delete the saved token.",
        responses: DEVICE_SETTINGS_RESPONSES,
      },
    },
  },
  deviceVault: {
    path: "/api/device/vault",
    auth: "bearer",
    methods: {
      GET: {
        summary: "The vault this daemon opens (this machine only).",
        responses: { 200: json(DeviceVaultResponseSchema, "The vault."), ...THIS_MACHINE_ONLY },
      },
      PUT: {
        summary:
          "Open another vault: writes `vaultPath` to `$DDL_HOME/config.json`, answers, then exits with `RESTART_EXIT_CODE` (75) to start again on it (the Mac app restarts it; a daemon started by hand is started again by the user).",
        body: DeviceVaultRequestSchema,
        responses: {
          200: json(
            DeviceVaultResponseSchema,
            "Switching (`restart` says who starts the daemon again), or already that vault (no `restart`).",
          ),
          400: invalidBody(),
          ...THIS_MACHINE_ONLY,
          409: error(
            ["locked_by_env", "conflict"],
            "`DDL_VAULT` sets the vault (`locked_by_env`), or it can't change now: an import runs, the vault syncs, or the daemon is already restarting (`conflict`).",
          ),
          ...BODY_ERRORS,
        },
      },
    },
  },
  importObsidianPreview: {
    path: "/api/import/obsidian/preview",
    auth: "bearer",
    methods: {
      POST: {
        summary:
          "What importing an Obsidian vault would do: its notes, attachments, settings, plugins, canvases and drawings, and the carry-over plan for the current vault. Reads the folder, writes nothing.",
        body: ObsidianImportPreviewRequestSchema,
        responses: {
          200: json(ObsidianImportPreviewSchema, "The report."),
          400: invalidBody(),
          ...THIS_MACHINE_ONLY,
          ...BODY_ERRORS,
        },
      },
    },
  },
  importObsidian: {
    path: "/api/import/obsidian",
    auth: "bearer",
    methods: {
      GET: {
        summary: "The running import or update, or the last one since the daemon started.",
        responses: {
          200: json(ObsidianImportStatusResponseSchema, "The job, or null."),
          ...THIS_MACHINE_ONLY,
        },
      },
      POST: {
        summary:
          "Import an Obsidian vault into a new vault and carry the current vault over; `import.progress` events follow the job.",
        body: ObsidianImportRequestSchema,
        responses: {
          202: json(ObsidianImportJobResponseSchema, "Started."),
          400: invalidBody(),
          ...THIS_MACHINE_ONLY,
          409: error(["conflict"], "An import or update is already running."),
          ...BODY_ERRORS,
        },
      },
    },
  },
  importObsidianCancel: {
    path: "/api/import/obsidian/cancel",
    auth: "bearer",
    methods: {
      POST: {
        summary:
          "Stop the running import or update; answers once what it wrote is removed (an update keeps the files it already copied).",
        responses: {
          200: json(ObsidianImportJobResponseSchema, "The stopped job."),
          ...THIS_MACHINE_ONLY,
          404: error(["not_found"], "Nothing is running."),
        },
      },
    },
  },
  importObsidianUpdate: {
    path: "/api/import/obsidian/update",
    auth: "bearer",
    methods: {
      POST: {
        summary:
          "Copy what changed in the Obsidian vault since the import into this vault, keeping both versions of a file changed on both sides; never deletes.",
        responses: {
          202: json(ObsidianImportJobResponseSchema, "Started."),
          ...THIS_MACHINE_ONLY,
          404: error(
            ["not_found"],
            "This vault wasn't imported from Obsidian, or the Obsidian vault isn't where it was.",
          ),
          409: error(["conflict"], "An import or update is already running."),
        },
      },
    },
  },
  pairingCodes: {
    path: "/api/pairing-codes",
    auth: "bearer",
    methods: {
      POST: {
        summary: "Issue a single-use pairing code for a new device (valid for a few minutes).",
        body: PairingCodeRequestSchema,
        responses: {
          201: json(PairingCodeResponseSchema, "The code."),
          400: invalidBody(),
          429: error(["rate_limited"], "Too many codes outstanding."),
          ...BODY_ERRORS,
        },
      },
    },
  },
  pair: {
    path: "/api/pair",
    auth: "pairing_code",
    methods: {
      POST: {
        summary:
          "Exchange a pairing code for a device credential: a token for `app` and `daemon`, an HttpOnly cookie for `browser`.",
        body: PairRequestSchema,
        responses: {
          201: json(PairResponseSchema, "Paired."),
          400: invalidBody(),
          401: error(["pairing_rejected"], "Wrong, expired or already used code."),
          429: error(["rate_limited"], "Too many attempts; try again in a minute."),
          ...BODY_ERRORS,
        },
      },
    },
  },
  devices: {
    path: "/api/devices",
    auth: "bearer",
    methods: {
      GET: {
        summary: "The devices paired with this daemon.",
        responses: { 200: json(PairedDevicesResponseSchema, "Paired devices.") },
      },
    },
  },
  pairedDevice: {
    path: "/api/devices/:id",
    auth: "bearer",
    params: z.object({ id: RuntimeIdSchema }),
    methods: {
      DELETE: {
        summary: "Revoke a paired device: its credential stops working and its sockets close.",
        responses: {
          204: { kind: "empty", description: "Revoked." },
          400: error(["invalid_request"], "Invalid device id."),
          404: error(["not_found"], "Unknown device."),
        },
      },
    },
  },
  machine: {
    path: "/api/machine",
    auth: "bearer",
    methods: {
      GET: {
        summary: "The always-on machine: address, this device's pairing and its last known status.",
        responses: { 200: json(MachineStatusResponseSchema, "Machine status.") },
      },
    },
  },
  machinePair: {
    path: "/api/machine/pair",
    auth: "bearer",
    methods: {
      POST: {
        summary:
          "Pair this device with the always-on machine using a code it issued, and make it the vault's always-on machine.",
        body: MachinePairRequestSchema,
        responses: {
          200: json(MachineStatusResponseSchema, "Paired: the machine's status."),
          400: invalidBody(),
          401: error(
            ["unauthorized", "pairing_rejected"],
            "Missing or invalid bearer token (`unauthorized`), or the machine rejected the code (`pairing_rejected`).",
          ),
          429: error(["rate_limited"], "The machine refused more attempts for now."),
          502: error(["machine_unreachable"], "The machine didn't answer."),
          ...BODY_ERRORS,
        },
      },
    },
  },
  machineCheck: {
    path: "/api/machine/check",
    auth: "bearer",
    methods: {
      POST: {
        summary: "Check the always-on machine now (reachability, version, agent, readiness).",
        responses: { 200: json(MachineStatusResponseSchema, "The fresh status.") },
      },
    },
  },
  machinePairing: {
    path: "/api/machine/pairing",
    auth: "bearer",
    methods: {
      DELETE: {
        summary:
          "Forget this device's credential for the always-on machine (revoked on the machine when it answers).",
        responses: { 200: json(MachineStatusResponseSchema, "Unpaired: the machine's status.") },
      },
    },
  },
  ws: {
    path: "/ws",
    auth: "upgrade",
    methods: {
      GET: {
        summary:
          "WebSocket upgrade (`Authorization` header, `?token=` on loopback Hosts, or a remote browser's cookie). Rejected upgrades answer 401/403/404 with an empty body; a revoked device's sockets close with 1008.",
        query: z.looseObject({
          token: z
            .string()
            .optional()
            .describe("The bearer token, on loopback Hosts only (refused on remote hosts)."),
        }),
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
