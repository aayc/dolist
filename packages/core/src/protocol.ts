/**
 * Wire protocol between the daemon and UI clients (web today; desktop/mobile shells later).
 *
 * Transport:
 *  - REST/JSON under `/api/*` for request/response.
 *  - One WebSocket at `/ws` for server push (`ServerEvent`) and light client signals (`ClientEvent`).
 *
 * Auth: every request carries `Authorization: Bearer <token>`; the WebSocket passes `?token=`.
 * The daemon binds to 127.0.0.1 and rejects foreign `Host`/`Origin` headers (DNS-rebinding/CSRF).
 */
import type {
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

export const API_VERSION = 1;

/** Header clients send so the daemon can tag the origin of a change and skip echoing it back. */
export const CLIENT_ID_HEADER = "x-ddl-client-id";

/** Route → methods (request body → response body). */
export const API_ROUTES = {
  /** GET → HealthResponse */
  health: "/api/health",
  /** GET → VaultTreeResponse */
  tree: "/api/vault/tree",
  /**
   * GET → NoteResponse · PUT WriteNoteRequest → WriteNoteResponse (201 created, 409
   * ConflictResponse) · DELETE → TrashResponse (moved into `.trash/`)
   */
  note: (path: string) => `/api/notes/${encodeVaultPath(path)}`,
  /** POST RenameRequest → WriteNoteResponse (note) | FolderRenameResponse (folder); 409 on conflict */
  rename: "/api/notes-rename",
  /** POST CreateFolderRequest → { path } · DELETE `?path=` → TrashResponse */
  folders: "/api/folders",
  /** GET → DailyNoteResponse (creates from the template with `?create=1`) */
  daily: (date: string, create = true) => `/api/daily/${date}${create ? "?create=1" : ""}`,
  /** GET → SearchResponse */
  search: (q: string) => `/api/search?q=${encodeURIComponent(q)}`,
  /** GET → SettingsResponse · PUT UpdateSettingsRequest → SettingsResponse */
  settings: "/api/settings",
  /** GET → AgentStatusResponse */
  agentStatus: "/api/agent/status",
  /** PUT/POST SetAgentEnabledRequest → AgentStatusResponse */
  agentEnabled: "/api/agent/enabled",
  /** GET → TaskRecordsResponse */
  tasks: (notePath: string) => `/api/tasks?notePath=${encodeURIComponent(notePath)}`,
  /** GET (`?notePath=`, `?taskId=`) → ThreadListResponse */
  threads: "/api/threads",
  /** GET → ThreadResponse */
  thread: (id: string) => `/api/threads/${encodeURIComponent(id)}`,
  /** POST PostMessageRequest → OkResponse */
  threadMessages: (id: string) => `/api/threads/${encodeURIComponent(id)}/messages`,
  /** POST → OkResponse */
  threadCancel: (id: string) => `/api/threads/${encodeURIComponent(id)}/cancel`,
  /** POST → OkResponse */
  threadRetry: (id: string) => `/api/threads/${encodeURIComponent(id)}/retry`,
  /** GET (`?status=`) → ApprovalListResponse */
  approvals: "/api/approvals",
  /** GET → ApprovalResponse · POST ApprovalDecisionRequest → ApprovalResponse (409 if decided) */
  approval: (id: string) => `/api/approvals/${encodeURIComponent(id)}`,
  /** GET → artifact bytes (Content-Type from the artifact) */
  artifact: (threadId: string, artifactId: string) =>
    `/api/artifacts/${encodeURIComponent(threadId)}/${encodeURIComponent(artifactId)}`,
  /** GET → ConnectorsResponse */
  connectors: "/api/connectors",
  /** WebSocket: ServerEvent ⇄ ClientEvent */
  ws: "/ws",
} as const;

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

/** 409 body when `baseVersion` no longer matches. */
export interface ConflictResponse {
  error: "conflict";
  current: NoteResponse | null;
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

export interface CreateFolderRequest {
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

export interface DailyNoteResponse extends NoteResponse {
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
  decision: "approve" | "deny";
  scope?: ApprovalScope;
  note?: string;
}

export interface ApiErrorBody {
  error: string;
  message?: string;
}

// ── WebSocket events ───────────────────────────────────────────────────────

export type VaultChangeOrigin = "external" | "client" | "agent" | "sync";

export interface VaultChange {
  path: string;
  kind: "created" | "modified" | "deleted";
  version?: string;
}

export type ServerEvent =
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
  | { type: "error"; message: string };

export type ClientEvent =
  | { type: "hello"; clientId: string }
  | { type: "ping" }
  | { type: "surface.subscribe"; threadId: string; surface: SurfaceKind }
  | { type: "surface.unsubscribe"; threadId: string; surface: SurfaceKind }
  | { type: "thread.read"; threadId: string }
  /** Where the user is typing, so the orchestrator never jumps on a half-written task. */
  | { type: "editor.activity"; notePath: string; line: number };

export type ServerEventType = ServerEvent["type"];
export type ServerEventOf<T extends ServerEventType> = Extract<ServerEvent, { type: T }>;
