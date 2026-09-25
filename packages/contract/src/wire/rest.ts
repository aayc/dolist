/** REST bodies. Requests are strict (unknown keys rejected); responses tolerate unknown keys. */
import { z } from "zod";
import {
  ApprovalDecisionSchema,
  ApprovalRequestSchema,
  ApprovalScopeSchema,
  RoutineNotifySchema,
  RoutineSchema,
  RoutineTemplateSchema,
  RoutineUseSchema,
  TaskAgentRecordSchema,
  ThreadSchema,
  ThreadSummarySchema,
} from "./domain";
import {
  ContentVersionSchema,
  CountSchema,
  EpochMsSchema,
  IsoDateSchema,
  ModelIdSchema,
  NameSchema,
  RequestPathSchema,
  RuntimeIdSchema,
  VaultPathSchema,
  WIRE_LIMITS,
} from "./primitives";
import { named } from "./registry";
import { AgentPlacementStatusSchema, AgentReadinessSchema } from "./remote";
import { AppSettingsSchema } from "./settings";

// ── Vault ─────────────────────────────────────────────────────────────────

export const AgentModeSchema = named(
  "AgentMode",
  "`live` (real model), `mock` (deterministic scripts) or `off`.",
  z.enum(["live", "mock", "off"]),
);

export const HealthResponseSchema = named(
  "HealthResponse",
  "Liveness and versions. Clients should check `apiVersion` before anything else.",
  z.looseObject({
    ok: z.literal(true),
    version: z.string().min(1).max(100).describe("Daemon build version."),
    apiVersion: z.int().min(1).describe("Protocol major version (see API_VERSION)."),
    vaultName: z.string().max(WIRE_LIMITS.vaultNameLength),
    agentMode: AgentModeSchema,
  }),
);

export const VaultEntrySchema = named(
  "VaultEntry",
  "A visible file or folder of the vault (hidden paths are never listed).",
  z.looseObject({
    path: VaultPathSchema,
    kind: z.enum(["file", "folder"]),
    size: CountSchema.optional().describe("Bytes (files only)."),
    mtime: EpochMsSchema.optional(),
    version: ContentVersionSchema.optional(),
  }),
);

export const VaultTreeResponseSchema = named(
  "VaultTreeResponse",
  "Every visible file and folder of the vault.",
  z.looseObject({
    vaultName: z.string().max(WIRE_LIMITS.vaultNameLength),
    entries: z.array(VaultEntrySchema),
  }),
);

const noteFields = {
  path: VaultPathSchema,
  content: z.string(),
  version: ContentVersionSchema.describe("Send back as `baseVersion` for optimistic concurrency."),
  mtime: EpochMsSchema,
};

export const NoteResponseSchema = named(
  "NoteResponse",
  "A note's content and version.",
  z.looseObject(noteFields),
);

export const WriteNoteRequestSchema = named(
  "WriteNoteRequest",
  "Body of `PUT /api/notes/<path>`.",
  z.strictObject({
    content: z.string().max(WIRE_LIMITS.noteChars),
    baseVersion: ContentVersionSchema.nullable()
      .optional()
      .describe("Version edited from; `null` = create only (409 if it exists); omit to overwrite."),
  }),
);

const writeResultFields = {
  path: VaultPathSchema,
  version: ContentVersionSchema,
  mtime: EpochMsSchema,
};

export const WriteNoteResponseSchema = named(
  "WriteNoteResponse",
  "The written note's canonical path and new version.",
  z.looseObject(writeResultFields),
);

export const RenameRequestSchema = named(
  "RenameRequest",
  "Renames a note, or a folder with everything inside it when `from` is a folder.",
  z.strictObject({ from: RequestPathSchema, to: RequestPathSchema }),
);

export const FolderRenameResponseSchema = named(
  "FolderRenameResponse",
  "Result of renaming a folder.",
  z.looseObject({
    path: VaultPathSchema,
    moved: CountSchema.describe("Number of files moved."),
  }),
);

export const RenameResponseSchema = named(
  "RenameResponse",
  "A renamed note answers like a write; a renamed folder reports how many files moved.",
  z.union([WriteNoteResponseSchema, FolderRenameResponseSchema]),
);

export const CreateFolderRequestSchema = named(
  "CreateFolderRequest",
  "Body of `POST /api/folders`.",
  z.strictObject({ path: RequestPathSchema }),
);

export const CreateFolderResponseSchema = named(
  "CreateFolderResponse",
  "The created folder's canonical path.",
  z.looseObject({ path: VaultPathSchema }),
);

export const TrashResponseSchema = named(
  "TrashResponse",
  "Deletes are soft: the note or folder moved into the vault's `.trash/` folder.",
  z.looseObject({
    ok: z.literal(true),
    trashedTo: VaultPathSchema.describe("Where it went, e.g. `.trash/Old.md`."),
  }),
);

export const OkResponseSchema = named(
  "OkResponse",
  "Success without data.",
  z.looseObject({ ok: z.literal(true) }),
);

export const ThreadActionResponseSchema = named(
  "ThreadActionResponse",
  "200 when the runtime finished the action; 202 with `pending: true` when it continues in the background.",
  z.looseObject({ ok: z.literal(true), pending: z.literal(true).optional() }),
);

export const DailyNoteResponseSchema = named(
  "DailyNoteResponse",
  "A daily note, created from the template when requested.",
  z.looseObject({
    ...noteFields,
    date: IsoDateSchema,
    created: z.boolean().describe("True when this request created the note."),
  }),
);

export const SearchHitSchema = named(
  "SearchHit",
  "`name`: the note's name matched (line 0); `content`: the 0-based `line` matched.",
  z.looseObject({
    path: VaultPathSchema,
    kind: z.enum(["name", "content"]),
    line: CountSchema,
    preview: z.string(),
  }),
);

export const SearchResponseSchema = named(
  "SearchResponse",
  "Search hits, best first.",
  z.looseObject({ hits: z.array(SearchHitSchema) }),
);

// ── Settings ──────────────────────────────────────────────────────────────

export const SettingsResponseSchema = named(
  "SettingsResponse",
  "The effective settings.",
  z.looseObject({ settings: AppSettingsSchema }),
);

// ── Agent ─────────────────────────────────────────────────────────────────

export const ConnectorStatusSchema = named(
  "ConnectorStatus",
  "State of one MCP connector.",
  z.looseObject({
    name: NameSchema,
    transport: z.enum(["stdio", "http", "sse"]),
    state: z.enum(["disabled", "idle", "connecting", "connected", "error"]),
    toolCount: CountSchema,
    error: z.string().optional(),
  }),
);

export const ComputerHostAppSchema = named(
  "ComputerHostApp",
  "The app macOS attributes the daemon's privacy permissions to (the Daily Do List app, or the terminal or editor it runs from).",
  z.looseObject({
    name: z.string().min(1).max(WIRE_LIMITS.nameLength).describe("As listed in System Settings."),
    path: z
      .string()
      .min(1)
      .max(WIRE_LIMITS.requestPathLength)
      .optional()
      .describe("The `.app` bundle."),
    bundleId: z.string().min(1).max(WIRE_LIMITS.nameLength).optional(),
  }),
);

export const ComputerAccessSchema = named(
  "ComputerAccess",
  "Computer use on this Mac: its two privacy permissions and whether agents can operate apps in the background.",
  z.looseObject({
    accessibility: z.boolean().describe("Input and reading other apps' UI."),
    screenRecording: z
      .boolean()
      .describe("Screenshots. macOS applies a new grant after the host app restarts."),
    appControl: z
      .boolean()
      .describe(
        "The `ddl-computer` helper is available; otherwise computer use is screen-level only.",
      ),
    hostApp: ComputerHostAppSchema.optional().describe("Absent when it can't be determined."),
  }),
);

export const ExecutionStatusSchema = named(
  "ExecutionStatus",
  "The execution provider and what it can do.",
  z.looseObject({
    provider: NameSchema,
    capabilities: z.looseObject({
      shell: z.boolean(),
      browser: z.boolean(),
      computer: z.boolean(),
    }),
    computerAccess: ComputerAccessSchema.optional().describe(
      "Present where computer use exists (macOS with computer use enabled).",
    ),
  }),
);

export const AgentStatusResponseSchema = named(
  "AgentStatusResponse",
  "The agent runtime's state (also pushed as `agent.status`).",
  z.looseObject({
    mode: AgentModeSchema,
    enabled: z.boolean(),
    model: ModelIdSchema,
    running: CountSchema,
    queued: CountSchema,
    pendingApprovals: CountSchema,
    connectors: z.array(ConnectorStatusSchema),
    execution: ExecutionStatusSchema,
    problem: z.string().optional().describe("Why the agent cannot run, when it can't."),
    placement: AgentPlacementStatusSchema.optional().describe(
      "Where the agent runs for this device, and who runs it now.",
    ),
    readiness: AgentReadinessSchema.optional().describe(
      "This daemon's own readiness to run the agent.",
    ),
  }),
);

export const SetAgentEnabledRequestSchema = named(
  "SetAgentEnabledRequest",
  "Body of `PUT|POST /api/agent/enabled` (persisted as `agent.enabled`).",
  z.strictObject({ enabled: z.boolean() }),
);

export const SetAgentEnabledResponseSchema = AgentStatusResponseSchema;

export const TaskRecordsResponseSchema = named(
  "TaskRecordsResponse",
  "The agent records of one note's tasks.",
  z.looseObject({ records: z.array(TaskAgentRecordSchema) }),
);

export const ThreadListResponseSchema = named(
  "ThreadListResponse",
  "Thread summaries.",
  z.looseObject({ threads: z.array(ThreadSummarySchema) }),
);

export const ThreadResponseSchema = named(
  "ThreadResponse",
  "A full thread and every approval requested in it.",
  z.looseObject({ thread: ThreadSchema, approvals: z.array(ApprovalRequestSchema) }),
);

export const PostMessageRequestSchema = named(
  "PostMessageRequest",
  "A user reply in a thread. Surrounding whitespace is trimmed; it must not be empty.",
  z.strictObject({ text: z.string().trim().min(1).max(WIRE_LIMITS.userMessageChars) }),
);

export const ApprovalListResponseSchema = named(
  "ApprovalListResponse",
  "Approval requests.",
  z.looseObject({ approvals: z.array(ApprovalRequestSchema) }),
);

export const ApprovalResponseSchema = named(
  "ApprovalResponse",
  "One approval request.",
  z.looseObject({ approval: ApprovalRequestSchema }),
);

export const ApprovalDecisionRequestSchema = named(
  "ApprovalDecisionRequest",
  "Body of `POST /api/approvals/:id`.",
  z.strictObject({
    decision: ApprovalDecisionSchema,
    scope: ApprovalScopeSchema.optional(),
    note: z.string().max(WIRE_LIMITS.decisionNoteChars).optional(),
  }),
);

export const ConnectorsResponseSchema = named(
  "ConnectorsResponse",
  "Every configured MCP connector.",
  z.looseObject({ connectors: z.array(ConnectorStatusSchema) }),
);

// ── Routines ──────────────────────────────────────────────────────────────

export const RoutineListResponseSchema = named(
  "RoutineListResponse",
  "Every routine (sorted by name) and the starter templates for “New routine”.",
  z.looseObject({
    routines: z.array(RoutineSchema),
    templates: z.array(RoutineTemplateSchema),
  }),
);

export const RoutineResponseSchema = named(
  "RoutineResponse",
  "One routine.",
  z.looseObject({ routine: RoutineSchema }),
);

export const CreateRoutineRequestSchema = named(
  "CreateRoutineRequest",
  "Body of `POST /api/routines`: a new routine file `Routines/<name>.md`. The daemon checks the name (a file name) and the schedule (400 with the reason when it can't be read).",
  z.strictObject({
    name: z.string().min(1).max(100).describe("The file name, without `.md`."),
    schedule: z.string().trim().min(1).max(200).describe("e.g. `every weekday at 7:30`."),
    instructions: z.string().trim().min(1).max(8_000).describe("What each run does."),
    notify: RoutineNotifySchema.optional().describe("Default `always`."),
    uses: z.array(RoutineUseSchema).max(6).optional(),
    paused: z.boolean().optional(),
  }),
);

export const RoutineRunResponseSchema = named(
  "RoutineRunResponse",
  "A run started now: the routine and the run's thread.",
  z.looseObject({ routine: RoutineSchema, threadId: RuntimeIdSchema }),
);

// ── Sync ──────────────────────────────────────────────────────────────────

export const SyncStateSchema = named(
  "SyncState",
  "`idle`, `syncing`, `error` (see `lastError`) or `disabled` (no sync target).",
  z.enum(["idle", "syncing", "error", "disabled"]),
);

export const SyncTargetKindSchema = named(
  "SyncTargetKind",
  "`none`, `local` (another folder), `s3`, or `remote` (the sync service shared with other devices).",
  z.enum(["none", "local", "s3", "remote"]),
);

export const SyncStatusResponseSchema = named(
  "SyncStatusResponse",
  "The vault's sync state.",
  z.looseObject({
    state: SyncStateSchema,
    target: SyncTargetKindSchema,
    lastSyncedAt: EpochMsSchema.nullable().describe("When the last pass finished; null before it."),
    pendingChanges: CountSchema.describe("Files changed on either side and not synced yet."),
    conflicts: z.array(VaultPathSchema).describe("Conflict copies waiting to be resolved."),
    lastError: z.string().optional(),
    remoteHost: z.string().min(1).max(300).optional().describe("The sync server (`remote` only)."),
    deviceName: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe("This device's name as other devices see it (`remote` only)."),
  }),
);

// ── Computer use ──────────────────────────────────────────────────────────

export const ComputerPermissionPaneSchema = named(
  "ComputerPermissionPane",
  "A System Settings privacy pane computer use needs.",
  z.enum(["accessibility", "screenRecording"]),
);

export const ComputerPermissionsOpenRequestSchema = named(
  "ComputerPermissionsOpenRequest",
  "Body of `POST /api/computer/permissions/open`.",
  z.strictObject({ pane: ComputerPermissionPaneSchema }),
);
