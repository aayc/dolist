/**
 * Wire protocol between the daemon and UI clients (web today; desktop/mobile shells later).
 *
 * Transport:
 *  - REST/JSON under `/api/*` for request/response.
 *  - One WebSocket at `/ws` for server push (`ServerEvent`) and light client signals (`ClientEvent`).
 *
 * Auth: every request carries `Authorization: Bearer <token>`; the WebSocket passes `?token=`.
 * The daemon binds to 127.0.0.1 and rejects foreign `Host`/`Origin` headers (DNS-rebinding/CSRF).
 *
 * Runtime schemas for every shape here live in `@ddl/contract` (kept in lockstep by type tests);
 * the generated reference is `docs/PROTOCOL.md`.
 */
import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalScope,
  SurfaceFrame,
  SurfaceKind,
  TaskAgentRecord,
  Thread,
  ThreadMessage,
  ThreadSummary,
} from "./agent-types";
import type { AppSettings, DeepPartial } from "./settings";

/**
 * Major version of the protocol, bumped only for breaking changes (everything else is additive).
 * A client and a daemon interoperate exactly when their API versions are equal.
 */
export const API_VERSION = 1;

export function isCompatibleApiVersion(apiVersion: number): boolean {
  return apiVersion === API_VERSION;
}

/** Application close codes (4000–4999) the daemon may use on `/ws`. */
export const WS_CLOSE_CODES = {
  /** The client's `hello.apiVersion` is not compatible with the daemon's `API_VERSION`. */
  incompatibleApiVersion: 4426,
} as const;

/** Header clients send so the daemon can tag the origin of a change and skip echoing it back. */
export const CLIENT_ID_HEADER = "x-ddl-client-id";

/** Route → methods (request body → response body per status). Errors answer `ApiErrorBody`. */
export const API_ROUTES = {
  /** GET → HealthResponse */
  health: "/api/health",
  /** GET → VaultTreeResponse */
  tree: "/api/vault/tree",
  /**
   * GET → NoteResponse · PUT WriteNoteRequest → WriteNoteResponse (200 overwritten, 201 created,
   * 409 ConflictResponse) · DELETE → TrashResponse (moved into `.trash/`)
   */
  note: (path: string) => `/api/notes/${encodeVaultPath(path)}`,
  /** POST RenameRequest → RenameResponse (a note or a whole folder); 409 on conflict */
  rename: "/api/notes-rename",
  /** POST CreateFolderRequest → 201 CreateFolderResponse · DELETE `?path=` → TrashResponse */
  folders: "/api/folders",
  /** GET → DailyNoteResponse (creates from the template with `?create=1`) */
  daily: (date: string, create = true) => `/api/daily/${date}${create ? "?create=1" : ""}`,
  /** GET (`?q=`, `?limit=`) → SearchResponse */
  search: (q: string) => `/api/search?q=${encodeURIComponent(q)}`,
  /** GET → SettingsResponse · PUT (or PATCH) UpdateSettingsRequest → SettingsResponse */
  settings: "/api/settings",
  /** GET → AgentStatusResponse */
  agentStatus: "/api/agent/status",
  /** PUT/POST SetAgentEnabledRequest → SetAgentEnabledResponse */
  agentEnabled: "/api/agent/enabled",
  /** GET → TaskRecordsResponse */
  tasks: (notePath: string) => `/api/tasks?notePath=${encodeURIComponent(notePath)}`,
  /** GET (`?notePath=`, `?taskId=`) → ThreadListResponse */
  threads: "/api/threads",
  /** GET → ThreadResponse */
  thread: (id: string) => `/api/threads/${encodeURIComponent(id)}`,
  /** POST PostMessageRequest → ThreadActionResponse (200 done, 202 still running) */
  threadMessages: (id: string) => `/api/threads/${encodeURIComponent(id)}/messages`,
  /** POST → ThreadActionResponse (200 done, 202 still running) */
  threadCancel: (id: string) => `/api/threads/${encodeURIComponent(id)}/cancel`,
  /** POST → ThreadActionResponse (200 done, 202 still running) */
  threadRetry: (id: string) => `/api/threads/${encodeURIComponent(id)}/retry`,
  /** GET (`?status=`) → ApprovalListResponse */
  approvals: "/api/approvals",
  /**
   * GET → ApprovalResponse · POST ApprovalDecisionRequest → ApprovalResponse (409
   * ApprovalConflictResponse when it is no longer pending)
   */
  approval: (id: string) => `/api/approvals/${encodeURIComponent(id)}`,
  /** GET → artifact bytes (Content-Type from the artifact; `?download=1` forces an attachment) */
  artifact: (threadId: string, artifactId: string) =>
    `/api/artifacts/${encodeURIComponent(threadId)}/${encodeURIComponent(artifactId)}`,
  /** GET → ConnectorsResponse */
  connectors: "/api/connectors",
  /** GET → SyncStatusResponse */
  syncStatus: "/api/sync/status",
  /** WebSocket: ServerEvent ⇄ ClientEvent */
  ws: "/ws",
} as const;

export type ApiRouteName = keyof typeof API_ROUTES;

/** Encodes each path segment but keeps `/` separators readable. */
export function encodeVaultPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function decodeVaultPath(encoded: string): string {
  return encoded.split("/").map(decodeURIComponent).join("/");
}

// ── REST shapes ────────────────────────────────────────────────────────────

export type AgentMode = "live" | "mock" | "off";

export interface HealthResponse {
  ok: true;
  version: string;
  apiVersion: number;
  vaultName: string;
  agentMode: AgentMode;
}

export interface VaultEntry {
  path: string;
  kind: "file" | "folder";
  size?: number;
  mtime?: number;
  version?: string;
}

export interface VaultTreeResponse {
  vaultName: string;
  entries: VaultEntry[];
}

export interface NoteResponse {
  path: string;
  content: string;
  /** Opaque content version (hash). Send back as `baseVersion` for optimistic concurrency. */
  version: string;
  mtime: number;
}

export interface WriteNoteRequest {
  content: string;
  /** Version the client edited from. `null` = create (fails if the note exists). Omit to force. */
  baseVersion?: string | null;
}

export interface WriteNoteResponse {
  path: string;
  version: string;
  mtime: number;
}

/** Renames a note, or a folder (moving everything inside it) when `from` is a folder. */
export interface RenameRequest {
  from: string;
  to: string;
}

export interface FolderRenameResponse {
  path: string;
  /** Number of files moved. */
  moved: number;
}

/** A renamed note answers like a write; a renamed folder reports how many files moved. */
export type RenameResponse = WriteNoteResponse | FolderRenameResponse;

export interface CreateFolderRequest {
  path: string;
}

/** 201 body of `POST /api/folders`: the normalized folder path. */
export interface CreateFolderResponse {
  path: string;
}

/** Deletes are soft: the note/folder moves into the vault's `.trash/` folder. */
export interface TrashResponse {
  ok: true;
  trashedTo: string;
}

export interface OkResponse {
  ok: true;
}

/**
 * Thread actions (message, cancel, retry) wait briefly for the runtime: 200 when it finished,
 * 202 with `pending: true` when it keeps going in the background (its effects arrive as events).
 */
export interface ThreadActionResponse {
  ok: true;
  pending?: true;
}

export interface DailyNoteResponse extends NoteResponse {
  /** Local ISO date (YYYY-MM-DD). */
  date: string;
  created: boolean;
}

export interface SearchHit {
  path: string;
  /** `name`: the note's name matched; `content`: a line matched. */
  kind: "name" | "content";
  /** 0-based line of a `content` hit (0 for `name` hits). */
  line: number;
  preview: string;
}

export interface SearchResponse {
  hits: SearchHit[];
}

export interface SettingsResponse {
  settings: AppSettings;
}

/** A deep partial of AppSettings (PATCH semantics); unknown keys are rejected. */
export type UpdateSettingsRequest = DeepPartial<AppSettings>;

export interface ConnectorStatus {
  name: string;
  transport: "stdio" | "http" | "sse";
  state: "disabled" | "idle" | "connecting" | "connected" | "error";
  toolCount: number;
  error?: string;
}

export interface ExecutionStatus {
  provider: string;
  capabilities: { shell: boolean; browser: boolean; computer: boolean };
}

export interface AgentStatusResponse {
  mode: AgentMode;
  enabled: boolean;
  model: string;
  running: number;
  queued: number;
  pendingApprovals: number;
  connectors: ConnectorStatus[];
  execution: ExecutionStatus;
  /** Present when the agent cannot run (e.g. missing OPENROUTER_API_KEY). */
  problem?: string;
}

export interface SetAgentEnabledRequest {
  enabled: boolean;
}

/** The switch is persisted as `agent.enabled`; the answer is the resulting agent status. */
export type SetAgentEnabledResponse = AgentStatusResponse;

export interface TaskRecordsResponse {
  records: TaskAgentRecord[];
}

export interface ThreadListResponse {
  threads: ThreadSummary[];
}

export interface ThreadResponse {
  thread: Thread;
  approvals: ApprovalRequest[];
}

export interface PostMessageRequest {
  text: string;
}

export interface ApprovalListResponse {
  approvals: ApprovalRequest[];
}

export interface ApprovalResponse {
  approval: ApprovalRequest;
}

export interface ConnectorsResponse {
  connectors: ConnectorStatus[];
}

export interface ApprovalDecisionRequest {
  decision: ApprovalDecision;
  scope?: ApprovalScope;
  note?: string;
}

/** `disabled` = no sync target configured. */
export type SyncState = "idle" | "syncing" | "error" | "disabled";

/** Where the vault syncs: nowhere, another folder, S3, or the sync service (other devices). */
export type SyncTargetKind = "none" | "local" | "s3" | "remote";

export interface SyncStatusResponse {
  state: SyncState;
  target: SyncTargetKind;
  /** When the last pass finished (epoch ms), or null before the first one. */
  lastSyncedAt: number | null;
  /** Files changed on either side and not synced yet (retried ones included). */
  pendingChanges: number;
  /** Conflict copies (vault paths) waiting for the user to resolve them. */
  conflicts: string[];
  /** Why the last pass failed, or which files it couldn't sync. */
  lastError?: string;
  /** `host[:port]` of the sync server (`remote` only). */
  remoteHost?: string;
  /** This device's name as other devices see it (`remote` only). */
  deviceName?: string;
}

// ── Errors ────────────────────────────────────────────────────────────────

/**
 * Every `error` code the daemon answers with. Clients must treat a code they don't know like any
 * other failure with that HTTP status (codes may be added without an API version bump).
 */
export type ApiErrorCode =
  /** 400: the body is not JSON. */
  | "invalid_json"
  /** 400: body, query or route parameter failed validation. */
  | "invalid_request"
  /** 400: a vault path is malformed, hidden (dot-files, sidecar) or not a text note. */
  | "invalid_path"
  /** 400: the stored settings make the request impossible (e.g. daily notes in a hidden folder). */
  | "invalid_settings"
  /** 401: missing or wrong bearer token. */
  | "unauthorized"
  /** 403: the Host header is not a loopback address of this daemon (DNS rebinding). */
  | "forbidden_host"
  /** 403: the Origin header is not allowed (CSRF). */
  | "forbidden_origin"
  /** 404: unknown route, or the addressed note/folder/thread/approval/artifact doesn't exist. */
  | "not_found"
  /** 409: optimistic-concurrency conflict, existing target, or an approval already decided. */
  | "conflict"
  /** 413: request body over 5 MB. */
  | "payload_too_large"
  /** 426: `/ws` requested without a WebSocket upgrade. */
  | "upgrade_required"
  /** 4xx/5xx raised by the HTTP framework itself. */
  | "http_error"
  /** 500: an agent action failed unexpectedly. */
  | "agent_error"
  /** 500: unexpected daemon failure. */
  | "internal_error"
  /** 503: the agent runtime can't act right now (mode off, missing API key, safety system down). */
  | "agent_unavailable";

export interface ApiErrorBody {
  error: ApiErrorCode;
  message?: string;
}

/** 409 body of a note write or rename whose target changed; `current` is null if it's gone. */
export interface ConflictResponse extends ApiErrorBody {
  error: "conflict";
  current: NoteResponse | null;
}

/** 409 body of `POST /api/approvals/:id` when the approval is no longer pending. */
export interface ApprovalConflictResponse extends ApiErrorBody {
  error: "conflict";
  approval: ApprovalRequest;
}

// ── WebSocket events ───────────────────────────────────────────────────────

export type VaultChangeOrigin = "external" | "client" | "agent" | "sync";

export interface VaultChange {
  path: string;
  kind: "created" | "modified" | "deleted";
  version?: string;
}

/** Machine-readable reason of a server `error` event. */
export type WsErrorCode =
  /** The message was not JSON. */
  | "invalid_json"
  /** JSON, but not a valid ClientEvent. */
  | "invalid_message"
  /** Binary frames are not part of the protocol. */
  | "binary_unsupported"
  | "too_many_subscriptions"
  | "subscribe_failed"
  /** `hello.apiVersion` is incompatible; the daemon closes with `WS_CLOSE_CODES.incompatibleApiVersion`. */
  | "incompatible_api_version";

export type ServerEvent =
  /** First event on every connection. */
  | { type: "hello"; serverVersion: string; apiVersion: number }
  | {
      type: "vault.changed";
      changes: VaultChange[];
      origin: VaultChangeOrigin;
      /** Client that caused the change (so it can ignore its own echo). */
      clientId?: string;
    }
  | { type: "task.records"; notePath: string; records: TaskAgentRecord[] }
  | { type: "task.record"; record: TaskAgentRecord }
  | { type: "thread.upsert"; thread: ThreadSummary }
  | { type: "thread.message"; threadId: string; message: ThreadMessage }
  | { type: "thread.delta"; threadId: string; messageId: string; delta: string }
  | { type: "approval.upsert"; approval: ApprovalRequest }
  | { type: "agent.status"; status: AgentStatusResponse }
  | ({ type: "surface.frame" } & SurfaceFrame)
  | { type: "settings.changed"; settings: AppSettings }
  | { type: "error"; message: string; code?: WsErrorCode };

export type ClientEvent =
  | {
      type: "hello";
      clientId: string;
      /** API_VERSION the client was built against. Absent = a client from before the handshake (1). */
      apiVersion?: number;
      /** Client build for diagnostics, e.g. `web/0.1.0`. */
      clientVersion?: string;
    }
  | { type: "ping" }
  | { type: "surface.subscribe"; threadId: string; surface: SurfaceKind }
  | { type: "surface.unsubscribe"; threadId: string; surface: SurfaceKind }
  | { type: "thread.read"; threadId: string }
  /** Where the user is typing, so the orchestrator never jumps on a half-written task. */
  | { type: "editor.activity"; notePath: string; line: number };

export type ServerEventType = ServerEvent["type"];
export type ServerEventOf<T extends ServerEventType> = Extract<ServerEvent, { type: T }>;
/** A server event's fields without its `type` tag. */
export type ServerEventPayload<T extends ServerEventType> = Omit<ServerEventOf<T>, "type">;

export type ClientEventType = ClientEvent["type"];
export type ClientEventOf<T extends ClientEventType> = Extract<ClientEvent, { type: T }>;
