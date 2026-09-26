import {
  compareStrings,
  errorMessage,
  folderHoldsAgentOwnedPaths,
  InvalidPathError,
  isAgentOwnedPath,
  isHiddenPath,
  isRecord,
  LEASE_EPOCH_HEADER,
  type Logger,
  normalizePath,
  SYNC_LIMITS,
  SYNC_ROUTES,
  type SyncChange,
  type SyncChangesResponse,
  type SyncCreateFolderRequest,
  type SyncDeleteFolderResponse,
  type SyncErrorCode,
  type SyncFileEntry,
  type SyncFileListResponse,
  type SyncFileResponse,
  type SyncFolderListResponse,
  type SyncRenameRequest,
  type SyncWriteFileRequest,
  type SyncWriteResponse,
  silentLogger,
  toVaultPath,
  type Unsubscribe,
} from "@ddl/core";
import { toStorableText } from "./file-types";
import { IgnoreRules } from "./ignore-rules";
import { type SyncRequest, SyncRequestError, SyncServiceClient } from "./remote-client";
import {
  ConflictError,
  type FileContent,
  type FileEntry,
  type ListOptions,
  NotFoundError,
  type RemoteStorageConfig,
  StaleLeaseError,
  type StorageCapabilities,
  StorageError,
  type StorageEvent,
  type StorageProvider,
  type WriteOptions,
  type WriteResult,
} from "./types";

/** A WebSocket constructor that sends request headers: Node's (undici's) does, a browser's doesn't. */
export type WebSocketWithHeaders = new (
  url: string,
  init: { headers: Record<string, string> },
) => WebSocket;

export interface RemoteStorageOptions extends Omit<RemoteStorageConfig, "kind"> {
  logger?: Logger;
  /**
   * The epoch of the agent lease grant this device holds, or null. While set, changes to the
   * agent's files carry it (`LEASE_EPOCH_HEADER`); without it the server refuses them.
   */
  leaseEpoch?: () => number | null;
  requestTimeoutMs?: number;
  /** Stream reconnection backoff: doubles from `initial` up to `max` (with jitter). */
  reconnectDelayMs?: { initial?: number; max?: number };
  fetch?: typeof fetch;
  WebSocket?: WebSocketWithHeaders;
}

const DEFAULT_RECONNECT = { initial: 500, max: 30_000 };
/** No `ready` within this long after opening: the connection attempt failed. */
const CONNECT_TIMEOUT_MS = 15_000;

/**
 * The sync service (`apps/sync`) as a StorageProvider, so the SyncEngine syncs a vault with it
 * like with any other target. Versions are the server's revs; conditional writes and deletes map
 * to the server's `ifMatch`, a stale one to `ConflictError`. It behaves like `MemoryStorageProvider`
 * (normalized paths, folders that outlive their files, junk and hidden paths filtered) and emits
 * `self` events for its own changes.
 *
 * `watch()` holds a WebSocket to the vault's change stream while anyone listens. Changes made by
 * other devices arrive as `self: false` events; changes this device made (`device` = ours) were
 * already reported when they were written and are not repeated. The stream reconnects with a
 * capped exponential backoff and then replays the changes it missed from the change log, so a
 * listener (the SyncEngine) runs a pass for them.
 */
export class RemoteStorageProvider implements StorageProvider {
  readonly kind = "remote" as const;
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: StorageCapabilities = { watch: true, atomicWrites: true, folders: true };
  readonly deviceName: string;
  readonly client: SyncServiceClient;
  readonly #logger: Logger;
  readonly #leaseEpoch: () => number | null;
  readonly #rules = new IgnoreRules();
  readonly #listeners = new Set<(event: StorageEvent) => void>();
  readonly #abort = new AbortController();
  readonly #WebSocket: WebSocketWithHeaders;
  readonly #reconnect: { initial: number; max: number };
  #ws: WebSocket | null = null;
  #connected = false;
  #attempt = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #silenceTimer: ReturnType<typeof setTimeout> | undefined;
  #heartbeatMs = 25_000;
  /** Changes up to this seq were delivered by the stream (or its catch-up). */
  #cursor: number | null = null;
  /** `seq` of the latest full listing: its caller has seen every change up to it. */
  #observedSeq: number | null = null;
  /** Set when the stream got ready before any listing: a listing older than it must catch up. */
  #readyFloor: number | null = null;
  #disposed = false;

  constructor(options: RemoteStorageOptions) {
    this.client = new SyncServiceClient({
      url: options.url,
      vault: options.vault,
      token: options.token,
      deviceId: options.deviceId,
      ...(options.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: options.requestTimeoutMs }
        : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    this.id = `remote-${this.client.host}-${options.vault}`;
    this.displayName = `${this.client.host}/${options.vault}`;
    this.deviceName = options.deviceName;
    this.#logger = (options.logger ?? silentLogger).child({ component: "storage.remote" });
    this.#leaseEpoch = options.leaseEpoch ?? (() => null);
    this.#WebSocket =
      options.WebSocket ?? (globalThis.WebSocket as unknown as WebSocketWithHeaders);
    this.#reconnect = { ...DEFAULT_RECONNECT, ...options.reconnectDelayMs };
  }

  /** `host[:port]` of the sync server. */
  get host(): string {
    return this.client.host;
  }

  get deviceId(): string {
    return this.client.deviceId;
  }

  /** True while the live change stream is connected. */
  get streamConnected(): boolean {
    return this.#connected;
  }

  async list(options: ListOptions = {}): Promise<FileEntry[]> {
    const prefix = listPrefix(options);
    const response = required(
      (
        await this.#request<SyncFileListResponse>("GET", SYNC_ROUTES.files(this.client.vault), {
          query: { prefix: prefix || undefined },
        })
      ).body,
    );
    if (!prefix) this.#observed(response.seq);
    return response.files
      .filter((file) => this.#visible(file.path, options))
      .map(toFileEntry)
      .sort((a, b) => compareStrings(a.path, b.path));
  }

  async listFolders(options: ListOptions = {}): Promise<string[]> {
    const prefix = listPrefix(options);
    const { folders } = required(
      (
        await this.#request<SyncFolderListResponse>("GET", SYNC_ROUTES.folders(this.client.vault), {
          query: { prefix: prefix || undefined },
        })
      ).body,
    );
    return folders.filter((folder) => this.#visible(folder, options)).sort(compareStrings);
  }

  async stat(path: string): Promise<FileEntry | null> {
    const p = toVaultPath(path);
    const { status, body } = await this.#request<SyncFileEntry>(
      "GET",
      SYNC_ROUTES.file(this.client.vault, p),
      { query: { meta: "1" }, accept: [404] },
    );
    return status === 404 ? null : toFileEntry(required(body));
  }

  async read(path: string): Promise<FileContent | null> {
    const p = toVaultPath(path);
    const { status, body } = await this.#request<SyncFileResponse>(
      "GET",
      SYNC_ROUTES.file(this.client.vault, p),
      { accept: [404] },
    );
    if (status === 404) return null;
    const file = required(body);
    return { ...toFileEntry(file), content: file.content };
  }

  async write(path: string, content: string, options: WriteOptions = {}): Promise<WriteResult> {
    const p = toVaultPath(path);
    const request: SyncWriteFileRequest = {
      content: toStorableText(content),
      ...(options.ifMatch !== undefined ? { ifMatch: options.ifMatch } : {}),
    };
    const written = required(
      (
        await this.#request<SyncWriteResponse>("PUT", SYNC_ROUTES.file(this.client.vault, p), {
          body: request,
          mutating: true,
          path: p,
          headers: this.#fenceHeaders(isAgentOwnedPath(p)),
        })
      ).body,
    );
    this.#emit({
      kind: written.created ? "created" : "modified",
      path: written.path,
      version: written.rev,
      self: true,
    });
    return {
      path: written.path,
      version: written.rev,
      mtime: written.mtime,
      size: written.size,
      created: written.created,
    };
  }

  async delete(path: string, options: WriteOptions = {}): Promise<void> {
    const p = toVaultPath(path);
    if (options.ifMatch === null) {
      // "Only if absent" can never delete anything: answer like the other providers do.
      const current = await this.stat(p);
      if (current) throw new ConflictError(p, current.version);
      throw new NotFoundError(p);
    }
    await this.#request("DELETE", SYNC_ROUTES.file(this.client.vault, p), {
      query: { ifMatch: options.ifMatch },
      mutating: true,
      path: p,
      headers: this.#fenceHeaders(isAgentOwnedPath(p)),
    });
    this.#emit({ kind: "deleted", path: p, self: true });
  }

  async rename(from: string, to: string): Promise<WriteResult> {
    const src = toVaultPath(from);
    const dst = toVaultPath(to);
    const request: SyncRenameRequest = { from: src, to: dst };
    const moved = required(
      (
        await this.#request<SyncWriteResponse>("POST", SYNC_ROUTES.rename(this.client.vault), {
          body: request,
          mutating: true,
          path: (code) => (code === "not_found" ? src : dst),
          headers: this.#fenceHeaders(isAgentOwnedPath(src) || isAgentOwnedPath(dst)),
        })
      ).body,
    );
    this.#emit({ kind: "deleted", path: src, self: true });
    this.#emit({ kind: "created", path: moved.path, version: moved.rev, self: true });
    return {
      path: moved.path,
      version: moved.rev,
      mtime: moved.mtime,
      size: moved.size,
      created: true,
    };
  }

  async createFolder(path: string): Promise<void> {
    const p = toVaultPath(path);
    const request: SyncCreateFolderRequest = { path: p };
    await this.#request("POST", SYNC_ROUTES.folders(this.client.vault), {
      body: request,
      mutating: true,
      path: p,
    });
  }

  async deleteFolder(path: string): Promise<void> {
    const p = toVaultPath(path);
    const { deleted } = required(
      (
        await this.#request<SyncDeleteFolderResponse>(
          "DELETE",
          SYNC_ROUTES.folders(this.client.vault),
          {
            query: { path: p },
            mutating: true,
            path: p,
            headers: this.#fenceHeaders(folderHoldsAgentOwnedPaths(p)),
          },
        )
      ).body,
    );
    for (const file of [...deleted].sort(compareStrings)) {
      this.#emit({ kind: "deleted", path: file, self: true });
    }
  }

  watch(listener: (event: StorageEvent) => void): Unsubscribe {
    this.#listeners.add(listener);
    if (this.#listeners.size === 1) this.#startStream();
    return () => {
      if (this.#listeners.delete(listener) && this.#listeners.size === 0) this.#stopStream();
    };
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#listeners.clear();
    this.#stopStream();
    this.#abort.abort();
  }

  // ── Requests ─────────────────────────────────────────────────────────────

  async #request<T>(
    method: string,
    route: string,
    init: SyncRequest & { path?: string | ((code: SyncErrorCode | undefined) => string) } = {},
  ) {
    if (this.#disposed) throw new StorageError("The sync target was disposed");
    try {
      return await this.client.request<T>(method, route, { ...init, signal: this.#abort.signal });
    } catch (error) {
      if (!(error instanceof SyncRequestError)) throw error;
      const path = typeof init.path === "function" ? init.path(error.code) : init.path;
      throw toStorageError(error, path);
    }
  }

  /** The lease epoch for a change touching the agent's files, while this device holds the lease. */
  #fenceHeaders(agentOwned: boolean): Record<string, string> {
    const epoch = agentOwned ? this.#leaseEpoch() : null;
    return epoch === null ? {} : { [LEASE_EPOCH_HEADER]: String(epoch) };
  }

  #visible(path: string, options: ListOptions): boolean {
    return !this.#rules.isIgnored(path) && (options.includeHidden === true || !isHiddenPath(path));
  }

  #emit(event: StorageEvent): void {
    if (this.#rules.isIgnored(event.path)) return;
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.#logger.error("storage listener threw", { error: errorMessage(error) });
      }
    }
  }

  // ── Change stream ────────────────────────────────────────────────────────

  #startStream(): void {
    if (this.#disposed || this.#ws || this.#reconnectTimer) return;
    this.#connect();
  }

  #stopStream(): void {
    clearTimeout(this.#reconnectTimer);
    clearTimeout(this.#silenceTimer);
    this.#reconnectTimer = undefined;
    this.#silenceTimer = undefined;
    const ws = this.#ws;
    this.#ws = null;
    this.#connected = false;
    this.#cursor = null;
    this.#readyFloor = null;
    this.#attempt = 0;
    if (ws) closeQuietly(ws);
  }

  #connect(): void {
    let ws: WebSocket;
    try {
      ws = new this.#WebSocket(this.client.streamUrl(), { headers: this.client.streamHeaders() });
    } catch (error) {
      this.#logger.warn("could not open the sync stream", { error: errorMessage(error) });
      this.#scheduleReconnect();
      return;
    }
    this.#ws = ws;
    this.#armSilenceTimer(CONNECT_TIMEOUT_MS);
    ws.onmessage = (event: MessageEvent) => {
      if (this.#ws !== ws || typeof event.data !== "string") return;
      this.#armSilenceTimer(this.#heartbeatMs * 2 + 5_000);
      this.#onFrame(event.data);
    };
    ws.onclose = () => {
      if (this.#ws === ws) this.#dropConnection();
    };
    // A close event follows every error.
    ws.onerror = () => {};
  }

  /** Forgets the current connection (closed, or presumed dead) and schedules the next one. */
  #dropConnection(): void {
    const ws = this.#ws;
    this.#ws = null;
    clearTimeout(this.#silenceTimer);
    if (this.#connected) this.#logger.debug("sync stream disconnected");
    this.#connected = false;
    if (ws) closeQuietly(ws);
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (this.#disposed || this.#listeners.size === 0 || this.#reconnectTimer) return;
    const delay = reconnectDelay(this.#attempt++, this.#reconnect);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      if (!this.#disposed && this.#listeners.size > 0 && !this.#ws) this.#connect();
    }, delay);
    this.#reconnectTimer.unref?.();
  }

  #armSilenceTimer(ms: number): void {
    clearTimeout(this.#silenceTimer);
    this.#silenceTimer = setTimeout(() => {
      this.#logger.debug("sync stream went silent; reconnecting");
      this.#dropConnection();
    }, ms);
    this.#silenceTimer.unref?.();
  }

  #onFrame(data: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(frame) || !isSeq(frame.seq)) return;
    switch (frame.type) {
      case "ready":
        this.#onReady(frame.seq, frame.heartbeatMs);
        return;
      case "change": {
        const change = asChange(frame);
        if (!change || (this.#cursor !== null && change.seq <= this.#cursor)) return;
        this.#cursor = change.seq;
        if (change.device !== this.deviceId) this.#emitChange(change);
        return;
      }
      case "heartbeat":
        this.#onHeartbeat(frame.seq);
        return;
    }
  }

  #onReady(seq: number, heartbeatMs: unknown): void {
    this.#attempt = 0;
    this.#connected = true;
    if (typeof heartbeatMs === "number" && heartbeatMs >= 1_000 && heartbeatMs <= 600_000) {
      this.#heartbeatMs = heartbeatMs;
    }
    this.#armSilenceTimer(this.#heartbeatMs * 2 + 5_000);
    const from = this.#cursor ?? this.#observedSeq;
    this.#cursor = seq;
    if (from === null) {
      this.#readyFloor = seq;
      return;
    }
    this.#readyFloor = null;
    // A log behind our position means the server's database was replaced: replay all of it.
    if (from !== seq) void this.#catchUp(from > seq ? 0 : from, seq);
  }

  #onHeartbeat(seq: number): void {
    const cursor = this.#cursor;
    if (cursor === null || seq === cursor) return;
    this.#cursor = seq;
    void this.#catchUp(seq > cursor ? cursor : 0, seq);
  }

  #observed(seq: number): void {
    this.#observedSeq = seq;
    const floor = this.#readyFloor;
    if (floor === null) return;
    this.#readyFloor = null;
    if (seq < floor) void this.#catchUp(seq, floor);
  }

  /** Emits the net effect of the changes other devices made after `from` up to `to`, per path. */
  async #catchUp(from: number, to: number): Promise<void> {
    try {
      const { body } = await this.#request<SyncChangesResponse>(
        "GET",
        SYNC_ROUTES.changes(this.client.vault),
        { query: { since: String(from), limit: String(SYNC_LIMITS.changesPage) } },
      );
      const net = new Map<string, { first: SyncChange; last: SyncChange }>();
      for (const change of body?.changes ?? []) {
        if (change.seq > to) break;
        if (change.device === this.deviceId) continue;
        const first = net.get(change.path)?.first ?? change;
        net.delete(change.path);
        net.set(change.path, { first, last: change });
      }
      for (const { first, last } of net.values()) {
        // Created and deleted again while we weren't looking: nothing to report.
        if (last.deleted && first.created) continue;
        this.#emitChange({ ...last, created: first.created && !last.deleted });
      }
    } catch (error) {
      if (!this.#disposed) {
        this.#logger.debug("could not replay missed changes", { error: errorMessage(error) });
      }
    }
  }

  #emitChange(change: SyncChange): void {
    this.#emit({
      kind: change.deleted ? "deleted" : change.created ? "created" : "modified",
      path: change.path,
      ...(change.rev !== null ? { version: change.rev } : {}),
      self: false,
    });
  }
}

/** Delay before reconnection attempt `attempt` (0-based): doubling, capped, with jitter. */
export function reconnectDelay(
  attempt: number,
  { initial, max }: { initial: number; max: number },
  random: () => number = Math.random,
): number {
  const base = Math.min(max, initial * 2 ** Math.min(attempt, 30));
  return Math.round(base / 2 + (random() * base) / 2);
}

function toStorageError(error: SyncRequestError, path: string | undefined): Error {
  const message = typeof error.body?.message === "string" ? error.body.message : error.message;
  switch (error.code) {
    case "conflict": {
      const current = error.body?.currentRev;
      return new ConflictError(path ?? "", typeof current === "string" ? current : null);
    }
    case "not_found":
      return path === undefined ? error : new NotFoundError(path);
    case "invalid_path":
      return new InvalidPathError(path ?? "", message);
    case "not_a_file":
    case "not_a_folder":
    case "path_blocked":
    case "payload_too_large":
    case "quota_exceeded":
      return new StorageError(message, path);
    case "stale_lease": {
      const current = error.body?.currentEpoch;
      return new StaleLeaseError(path ?? "", message, typeof current === "number" ? current : null);
    }
    default:
      return error;
  }
}

function listPrefix(options: ListOptions): string {
  return options.prefix ? normalizePath(options.prefix) : "";
}

function toFileEntry(entry: SyncFileEntry): FileEntry {
  return { path: entry.path, size: entry.size, mtime: entry.mtime, version: entry.rev };
}

function required<T>(body: T | undefined): T {
  if (body === undefined) throw new StorageError("The sync server sent an empty response");
  return body;
}

/** Code-point order, like the other providers (UIs apply their own display sort). */
function asChange(frame: Record<string, unknown>): SyncChange | null {
  const { seq, path, rev, deleted, created, device, at } = frame;
  if (!isSeq(seq) || typeof path !== "string" || typeof deleted !== "boolean") return null;
  if (rev !== null && typeof rev !== "string") return null;
  return {
    seq,
    path,
    rev,
    deleted,
    created: created === true,
    device: typeof device === "string" ? device : null,
    at: typeof at === "number" ? at : 0,
  };
}

function closeQuietly(ws: WebSocket): void {
  ws.onmessage = null;
  ws.onclose = null;
  ws.onerror = null;
  try {
    ws.close();
  } catch {
    // Already closing or closed.
  }
}

function isSeq(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
