import type {
  AgentStatusResponse,
  ApprovalDecisionRequest,
  ApprovalListResponse,
  ApprovalRequest,
  ClientEvent,
  ComputerPermissionPane,
  ConnectorStatus,
  CreateRoutineRequest,
  DailyNoteResponse,
  DeviceVaultResponse,
  HealthResponse,
  NoteResponse,
  ObsidianImportJobResponse,
  ObsidianImportPreview,
  ObsidianImportRequest,
  ObsidianImportStatusResponse,
  RoutineListResponse,
  RoutineResponse,
  RoutineRunResponse,
  SearchResponse,
  ServerEvent,
  SettingsResponse,
  SyncStatusResponse,
  TaskRecordsResponse,
  ThreadListResponse,
  ThreadResponse,
  Unsubscribe,
  UpdateSettingsRequest,
  VaultTreeResponse,
  WriteNoteRequest,
  WriteNoteResponse,
} from "@ddl/core";

export type ClientKind = "http" | "mock";

/**
 * `connecting`: first attempt; `online`: event stream open; `reconnecting`: dropped, retrying with
 * backoff; `offline`: stopped (disconnect() or the browser reports no network).
 */
export type ConnectionState = "connecting" | "online" | "reconnecting" | "offline";

export interface ConnectionChange {
  state: ConnectionState;
  /** True when the stream came back after a drop: callers must resync (events may be missed). */
  reconnected: boolean;
}

export interface WriteOptions {
  /** Let the request outlive the page (flush on unload). */
  keepalive?: boolean;
}

export interface ArtifactContent {
  mimeType: string;
  blob: Blob;
}

export interface ThreadFilter {
  /** Only this routine's runs. */
  routineId?: string;
}

/**
 * Everything the UI needs from the daemon: REST calls (`/api/*`), the server event stream (`/ws`)
 * and light client signals. Implemented by `HttpDaemonClient` and the in-browser `MockDaemonClient`.
 * Writes are tagged with `clientId` so the UI can ignore the echo of its own `vault.changed` events.
 */
export interface DaemonClient {
  readonly kind: ClientKind;
  readonly clientId: string;
  /** Human-readable endpoint for Settings → About. */
  readonly endpoint: string;
  readonly connectionState: ConnectionState;

  /** Opens the event stream (idempotent). Reconnects with backoff until `disconnect()`. */
  connect(): void;
  disconnect(): void;
  onEvent(listener: (event: ServerEvent) => void): Unsubscribe;
  onConnectionChange(listener: (change: ConnectionChange) => void): Unsubscribe;
  /** Fire-and-forget signal. Dropped while offline, except surface subscriptions (replayed). */
  send(event: ClientEvent): void;

  health(): Promise<HealthResponse>;
  getTree(): Promise<VaultTreeResponse>;
  readNote(path: string): Promise<NoteResponse>;
  /** Throws `ConflictError` when `baseVersion` is stale. */
  writeNote(
    path: string,
    body: WriteNoteRequest,
    options?: WriteOptions,
  ): Promise<WriteNoteResponse>;
  deleteNote(path: string): Promise<void>;
  /** Renames/moves a note or folder. */
  renamePath(from: string, to: string): Promise<void>;
  createFolder(path: string): Promise<void>;
  deleteFolder(path: string): Promise<void>;
  /** `date` is a local ISO date (YYYY-MM-DD). With `create`, the daemon renders the template. */
  getDailyNote(date: string, create?: boolean): Promise<DailyNoteResponse>;
  search(query: string): Promise<SearchResponse>;

  getSettings(): Promise<SettingsResponse>;
  updateSettings(patch: UpdateSettingsRequest): Promise<SettingsResponse>;

  getAgentStatus(): Promise<AgentStatusResponse>;
  setAgentEnabled(enabled: boolean): Promise<AgentStatusResponse | null>;
  getConnectors(): Promise<ConnectorStatus[]>;
  getTaskRecords(notePath: string): Promise<TaskRecordsResponse>;
  listThreads(filter?: ThreadFilter): Promise<ThreadListResponse>;
  getThread(id: string): Promise<ThreadResponse>;
  postMessage(threadId: string, text: string): Promise<void>;
  cancelThread(threadId: string): Promise<void>;
  retryThread(threadId: string): Promise<void>;
  listApprovals(): Promise<ApprovalListResponse>;
  /** Returns the updated approval when the daemon includes it (it is also pushed as an event). */
  decideApproval(id: string, decision: ApprovalDecisionRequest): Promise<ApprovalRequest | null>;
  getArtifact(threadId: string, artifactId: string): Promise<ArtifactContent>;
  /** Opens System Settings (on the daemon's Mac) at a privacy pane computer use needs. */
  openComputerPermissions(pane: ComputerPermissionPane): Promise<void>;

  listRoutines(): Promise<RoutineListResponse>;
  getRoutine(id: string): Promise<RoutineResponse>;
  /** Writes `Routines/<name>.md`. 400: the name or schedule can't be used (with why); 409: it exists. */
  createRoutine(request: CreateRoutineRequest): Promise<RoutineResponse>;
  /**
   * 409: a run is going, the routine has a problem, or today's extra runs are used up; 503: the
   * agent can't run on this device. Both carry a message to show.
   */
  runRoutine(id: string): Promise<RoutineRunResponse>;
  pauseRoutine(id: string): Promise<RoutineResponse>;
  resumeRoutine(id: string): Promise<RoutineResponse>;

  getSyncStatus(): Promise<SyncStatusResponse>;

  // This machine's vault and importing from Obsidian: a paired device gets 403 `forbidden_device`.
  /** The vault the daemon serves, and whether `DDL_VAULT` fixes it. */
  getVault(): Promise<DeviceVaultResponse>;
  /**
   * Restarts the daemon on another vault; `restart` says who starts it again (absent: already that
   * vault). 409 `locked_by_env`, or `conflict` while an import runs or the vault syncs.
   */
  switchVault(path: string): Promise<DeviceVaultResponse>;
  /** Reads the folder and reports what an import would do; writes nothing. 400 for a bad source. */
  previewObsidianImport(source: string): Promise<ObsidianImportPreview>;
  /** The running or last job, and where this vault was imported from. */
  getObsidianImport(): Promise<ObsidianImportStatusResponse>;
  /** 400 for a bad source or destination, 409 while a job runs; `import.progress` events follow. */
  startObsidianImport(request: ObsidianImportRequest): Promise<ObsidianImportJobResponse>;
  /** Answers once the partial vault is removed. 404 when nothing runs. */
  cancelObsidianImport(): Promise<ObsidianImportJobResponse>;
  /** 404 when this vault wasn't imported or the Obsidian vault moved, 409 while a job runs. */
  updateFromObsidian(): Promise<ObsidianImportJobResponse>;
}
