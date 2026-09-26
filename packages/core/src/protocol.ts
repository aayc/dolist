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
 * The shapes are the zod schemas in `@ddl/contract`; their inferred types are re-exported from
 * `./wire`. The generated reference is `docs/PROTOCOL.md`.
 */

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
  /**
   * GET → DeviceVaultResponse · PUT DeviceVaultRequest → DeviceVaultResponse, then the daemon
   * restarts on that vault (409 when `DDL_VAULT` sets it, an import runs or the vault syncs).
   * This machine only (403 for paired devices).
   */
  deviceVault: "/api/device/vault",
  /** POST ObsidianImportPreviewRequest → ObsidianImportPreview (reads the folder, writes nothing) */
  importObsidianPreview: "/api/import/obsidian/preview",
  /**
   * GET → ObsidianImportStatusResponse · POST ObsidianImportRequest → 202
   * ObsidianImportJobResponse (progress arrives as `import.progress` events; 409 while a job runs)
   */
  importObsidian: "/api/import/obsidian",
  /** POST → ObsidianImportJobResponse: the stopped job, once its partial work is removed (404 when none runs) */
  importObsidianCancel: "/api/import/obsidian/cancel",
  /** POST → 202 ObsidianImportJobResponse: copies what changed in Obsidian since the import (404 when there's nothing to update from) */
  importObsidianUpdate: "/api/import/obsidian/update",
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

/** Lists in import reports hold at most this many entries (their `count` is the full number). */
export const IMPORT_REPORT_LIMIT = 200;
