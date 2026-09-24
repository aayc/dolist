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

export const API_ROUTES = {
  health: "/api/health",
  tree: "/api/vault/tree",
  /** GET/PUT/DELETE `/api/notes/<encoded vault path>` */
  note: (path: string) => `/api/notes/${encodeVaultPath(path)}`,
  rename: "/api/notes-rename",
  folders: "/api/folders",
  /** GET `/api/daily/<YYYY-MM-DD|today>?create=1` */
  daily: (date: string, create = true) => `/api/daily/${date}${create ? "?create=1" : ""}`,
  search: (q: string) => `/api/search?q=${encodeURIComponent(q)}`,
  settings: "/api/settings",
  agentStatus: "/api/agent/status",
  agentEnabled: "/api/agent/enabled",
  tasks: (notePath: string) => `/api/tasks?notePath=${encodeURIComponent(notePath)}`,
  threads: "/api/threads",
  thread: (id: string) => `/api/threads/${encodeURIComponent(id)}`,
  threadMessages: (id: string) => `/api/threads/${encodeURIComponent(id)}/messages`,
  threadCancel: (id: string) => `/api/threads/${encodeURIComponent(id)}/cancel`,
  threadRetry: (id: string) => `/api/threads/${encodeURIComponent(id)}/retry`,
  approvals: "/api/approvals",
  approval: (id: string) => `/api/approvals/${encodeURIComponent(id)}`,
  artifact: (threadId: string, artifactId: string) =>
    `/api/artifacts/${encodeURIComponent(threadId)}/${encodeURIComponent(artifactId)}`,
  connectors: "/api/connectors",
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

export interface RenameRequest {
  from: string;
  to: string;
}

export interface CreateFolderRequest {
  path: string;
}

export interface DailyNoteResponse extends NoteResponse {
  date: string;
  created: boolean;
}

export interface SearchHit {
  path: string;
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
