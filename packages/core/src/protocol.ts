/**
 * Wire protocol between the daemon and UI clients (web today; desktop/mobile shells later).
 *
 * Transport:
 *  - REST/JSON under `/api/*` for request/response.
 *  - One WebSocket at `/ws` for server push (`ServerEvent`) and light client signals (`ClientEvent`).
 *
 * Auth: every request carries `Authorization: Bearer <token>` (the daemon's own token, or a paired
 * device's); the WebSocket takes the same header, or `?token=` on loopback Hosts only. A browser
 * on a remote host uses the HttpOnly device cookie it got when pairing instead. The exception is
 * `POST /api/pair`, where the pairing code in the body is the credential. The daemon binds to
 * 127.0.0.1 and rejects foreign `Host`/`Origin` headers (DNS-rebinding/CSRF); remote hosts are
 * configured names reached through a private-network proxy.
 *
 * Runtime schemas for every shape here live in `@ddl/contract` (kept in lockstep by type tests);
 * the generated reference is `docs/PROTOCOL.md`.
 */
import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalScope,
  OrchestratorActivity,
  Routine,
  RoutineNotification,
  RoutineNotify,
  RoutineTemplate,
  RoutineUse,
  SurfaceFrame,
  SurfaceKind,
  TaskAgentRecord,
  Thread,
  ThreadMessage,
  ThreadSummary,
} from "./agent-types";
import type { AgentHarnessKind, AlwaysOnMachine, AppSettings, DeepPartial } from "./settings";

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
  /** GET (`?notePath=`, `?taskId=`, `?routineId=`) → ThreadListResponse */
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
  /**
   * GET → RoutineListResponse · POST CreateRoutineRequest → 201 RoutineResponse (writes
   * `Routines/<name>.md`; 409 when it exists, 400 when the schedule can't be read)
   */
  routines: "/api/routines",
  /** GET → RoutineResponse */
  routine: (id: string) => `/api/routines/${encodeURIComponent(id)}`,
  /**
   * POST → RoutineRunResponse: runs it now (409 while a run is going or when today's extra runs
   * are used up; 503 while the agent can't run)
   */
  routineRun: (id: string) => `/api/routines/${encodeURIComponent(id)}/run`,
  /** POST → RoutineResponse (sets `paused: true` in the file) */
  routinePause: (id: string) => `/api/routines/${encodeURIComponent(id)}/pause`,
  /** POST → RoutineResponse (sets `paused: false` in the file) */
  routineResume: (id: string) => `/api/routines/${encodeURIComponent(id)}/resume`,
  /** GET → ConnectorsResponse */
  connectors: "/api/connectors",
  /** GET → SyncStatusResponse */
  syncStatus: "/api/sync/status",
  /**
   * POST ComputerPermissionsOpenRequest → OkResponse: opens System Settings at that privacy pane
   * (macOS; 404 elsewhere).
   */
  computerPermissionsOpen: "/api/computer/permissions/open",
  /**
   * GET → DeviceSettingsResponse · PATCH DeviceSettingsPatch → DeviceSettingsResponse (409 when a
   * field is set by an environment variable)
   */
  device: "/api/device",
  /** PUT DeviceSyncSetupRequest → DeviceSettingsResponse · DELETE → DeviceSettingsResponse (sync off) */
  deviceSync: "/api/device/sync",
  /** POST PairingCodeRequest → 201 PairingCodeResponse (429 when too many are outstanding) */
  pairingCodes: "/api/pairing-codes",
  /** POST PairRequest → 201 PairResponse. No bearer token: the pairing code is the credential. */
  pair: "/api/pair",
  /** GET → PairedDevicesResponse */
  devices: "/api/devices",
  /** DELETE → 204: revokes a paired device and closes its sockets */
  pairedDevice: (id: string) => `/api/devices/${encodeURIComponent(id)}`,
  /** GET → MachineStatusResponse */
  machine: "/api/machine",
  /** POST MachinePairRequest → MachineStatusResponse */
  machinePair: "/api/machine/pair",
  /** POST → MachineStatusResponse (checks the machine now) */
  machineCheck: "/api/machine/check",
  /** DELETE → MachineStatusResponse (drops this device's credential for the machine) */
  machinePairing: "/api/machine/pairing",
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

/** The app macOS attributes the daemon's privacy permissions to. */
export interface ComputerHostApp {
  /** As listed in System Settings, e.g. `Daily Do List`, `Terminal`. */
  name: string;
  /** The `.app` bundle. */
  path?: string;
  bundleId?: string;
}

/**
 * Computer use on this Mac: the two privacy permissions it needs and whether agents can operate
 * apps in the background (the `ddl-computer` helper).
 */
export interface ComputerAccess {
  /** Input and reading other apps' UI. */
  accessibility: boolean;
  /** Screenshots. macOS applies a new grant only after the host app restarts. */
  screenRecording: boolean;
  /** App control (background, accessibility-based) is available; otherwise screen-level only. */
  appControl: boolean;
  /** Absent when it can't be determined. */
  hostApp?: ComputerHostApp;
}

export interface ExecutionStatus {
  provider: string;
  capabilities: { shell: boolean; browser: boolean; computer: boolean };
  /** Present where computer use exists (macOS with computer use enabled). */
  computerAccess?: ComputerAccess;
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
  /** Where the agent runs for this device, and who runs it now. */
  placement?: AgentPlacementStatus;
  /** This daemon's own readiness to run the agent. */
  readiness?: AgentReadiness;
  /** What the orchestrator is doing now, for a client joining mid-turn (then `orchestrator.activity`). */
  orchestrator?: OrchestratorActivity;
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

export interface RoutineListResponse {
  /** Sorted by name. */
  routines: Routine[];
  /** Starter routines for "New routine". */
  templates: RoutineTemplate[];
}

export interface RoutineResponse {
  routine: Routine;
}

/** A new routine file, `Routines/<name>.md`. */
export interface CreateRoutineRequest {
  /** The file name, without `.md`. */
  name: string;
  schedule: string;
  instructions: string;
  /** Default `always`. */
  notify?: RoutineNotify;
  uses?: RoutineUse[];
  paused?: boolean;
}

export interface RoutineRunResponse {
  routine: Routine;
  /** The new run's thread. */
  threadId: string;
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

/** The System Settings privacy panes computer use needs. */
export type ComputerPermissionPane = "accessibility" | "screenRecording";

export interface ComputerPermissionsOpenRequest {
  pane: ComputerPermissionPane;
}

// ── Placement, readiness ───────────────────────────────────────────────────

/**
 * Where this device's agent runs (a device-local setting, never synced):
 * - `this_device`: here; it takes the agent lease over from the always-on machine.
 * - `always_on_machine`: never here; agent routes and events relay to the always-on machine.
 * - `always_on_host`: this is the always-on machine; it runs the agent when no `this_device` does.
 * Without sync a daemon is standalone and runs its own agent whatever the placement.
 */
export type AgentPlacement = "this_device" | "always_on_machine" | "always_on_host";

export interface AgentRunsOn {
  deviceId: string;
  name: string;
  thisDevice: boolean;
  /** The holder requested the lease with priority "host". */
  alwaysOnMachine: boolean;
}

export type RelayState = "off" | "connecting" | "connected" | "unreachable" | "not_paired";

export interface AgentPlacementStatus {
  /** The stored choice (see heldHere for when it can't apply). */
  placement: AgentPlacement;
  /**
   * Why the agent is held on this device despite the stored choice: no always-on machine is set
   * up (`no_machine`) or this device doesn't sync (`no_sync`). The stored choice applies again
   * once both are set up.
   */
  heldHere?: "no_machine" | "no_sync";
  /** Who runs the agent now (null: nobody, or unknown without sync). */
  runsOn: AgentRunsOn | null;
  relay: RelayState;
  /** Short, human ("Taking over from vm-1…", "Handing the agent to vm-1…"). */
  note?: string;
}

export interface AgentReadiness {
  harness: { kind: AgentHarnessKind; ready: boolean; problem?: string };
  /** A model credential for the configured harness is present (never the value). */
  modelCredential: boolean;
  browser: boolean;
  computer: "available" | "needs_permissions" | "unsupported";
  connectors: { configured: number; connected: number };
}

// ── This daemon's device-local settings ────────────────────────────────────

export interface DeviceSyncSetup {
  /** null: not syncing with the sync service. */
  url: string | null;
  vault: string | null;
  /** A vault token is saved (the token is never returned). */
  hasToken: boolean;
}

export interface DeviceSettingsResponse {
  device: { id: string; name: string };
  placement: AgentPlacement;
  /** Names this daemon answers to besides loopback (e.g. its tailnet name), lowercase. */
  remoteHosts: string[];
  sync: DeviceSyncSetup;
  /** Fields set by environment variables; the UI shows them read-only. */
  lockedByEnv: Array<"placement" | "remoteHosts" | "sync">;
}

export interface DeviceSettingsPatch {
  /** 1–64 characters, trimmed. */
  name?: string;
  placement?: AgentPlacement;
  /** DNS names (optional `:port`), at most 8, no IPs, no scheme or path (see `normalizeRemoteHost`). */
  remoteHosts?: string[];
}

export interface DeviceSyncSetupRequest {
  /** https (plain http only for loopback). */
  url: string;
  /** Sync vault id. */
  vault: string;
  /** Omit to keep the saved token. Written 0600 to `$DDL_HOME/sync-token`. */
  token?: string;
}

// ── Pairing (this daemon issuing device credentials) ───────────────────────

export type PairedDeviceKind = "browser" | "app" | "daemon";

export interface PairedDevice {
  id: string;
  name: string;
  kind: PairedDeviceKind;
  createdAt: number;
  lastSeenAt: number | null;
  /** The device making this request. */
  current?: boolean;
}

export interface PairingCodeRequest {
  name?: string;
}

export interface PairingCodeResponse {
  /** 8 characters, unambiguous alphabet, shown as XXXX-XXXX; single use. */
  code: string;
  expiresAt: number;
  /** https://<first remote host> for the QR code, or null without remote hosts. */
  url: string | null;
}

export interface PairRequest {
  code: string;
  name: string;
  kind: PairedDeviceKind;
}

export interface PairResponse {
  device: PairedDevice;
  /** For "app" and "daemon" kinds; a browser gets an HttpOnly cookie instead. */
  token?: string;
}

export interface PairedDevicesResponse {
  devices: PairedDevice[];
}

// ── The always-on machine, from this device's side ─────────────────────────

export interface MachineStatusResponse {
  machine: AlwaysOnMachine | null;
  /** This device holds a credential for it ($DDL_HOME/machine-token). */
  paired: boolean;
  /** null: not checked yet, or no machine. */
  reachable: boolean | null;
  checkedAt: number | null;
  version?: string;
  /** As the machine reports it. */
  agent?: { runsOn: AgentRunsOn | null; problem?: string };
  readiness?: AgentReadiness;
  error?: string;
}

export interface MachinePairRequest {
  /** `https://<tailnet name>[:port]`, no path, query or credentials (see `normalizeMachineUrl`). */
  url: string;
  code: string;
  /** Default: the first label of the host. */
  name?: string;
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
  /** 401: a pairing code was wrong, expired or already used (here, or on the always-on machine). */
  | "pairing_rejected"
  /** 403: the Host header is not a loopback address of this daemon (DNS rebinding). */
  | "forbidden_host"
  /** 403: the Origin header is not allowed (CSRF). */
  | "forbidden_origin"
  /** 404: unknown route, or the addressed note/folder/thread/approval/artifact doesn't exist. */
  | "not_found"
  /** 409: optimistic-concurrency conflict, existing target, or an approval already decided. */
  | "conflict"
  /** 409: a device setting is set by an environment variable (see `lockedByEnv`). */
  | "locked_by_env"
  /** 413: request body over 5 MB. */
  | "payload_too_large"
  /** 426: `/ws` requested without a WebSocket upgrade. */
  | "upgrade_required"
  /** 429: too many pairing attempts, or too many pairing codes outstanding. */
  | "rate_limited"
  /** 4xx/5xx raised by the HTTP framework itself. */
  | "http_error"
  /** 500: an agent action failed unexpectedly. */
  | "agent_error"
  /** 500: unexpected daemon failure. */
  | "internal_error"
  /** 502: the always-on machine didn't answer (network, TLS or timeout). */
  | "machine_unreachable"
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
  /** What the orchestrator is doing, whenever that changes (coalesced; never per keystroke). */
  | { type: "orchestrator.activity"; activity: OrchestratorActivity }
  | ({ type: "surface.frame" } & SurfaceFrame)
  | { type: "settings.changed"; settings: AppSettings }
  /** Every routine, whenever one changed (its file, its schedule, its last run). */
  | { type: "routines.changed"; routines: Routine[] }
  /** A run finished and its routine's `notify` says to tell the user. */
  | { type: "routine.notification"; notification: RoutineNotification }
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
