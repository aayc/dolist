import type {
  AgentStatusResponse,
  ApprovalDecisionRequest,
  ApprovalListResponse,
  ApprovalRequest,
  ClientEvent,
  ConnectorStatus,
  DailyNoteResponse,
  HealthResponse,
  NoteResponse,
  SearchResponse,
  ServerEvent,
  SettingsResponse,
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
  listThreads(): Promise<ThreadListResponse>;
  getThread(id: string): Promise<ThreadResponse>;
  postMessage(threadId: string, text: string): Promise<void>;
  cancelThread(threadId: string): Promise<void>;
  retryThread(threadId: string): Promise<void>;
  listApprovals(): Promise<ApprovalListResponse>;
  /** Returns the updated approval when the daemon includes it (it is also pushed as an event). */
  decideApproval(id: string, decision: ApprovalDecisionRequest): Promise<ApprovalRequest | null>;
  getArtifact(threadId: string, artifactId: string): Promise<ArtifactContent>;
}
