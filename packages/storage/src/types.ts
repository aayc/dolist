/**
 * Storage Provider contract. A provider stores a flat namespace of vault-relative POSIX paths
 * (see `@ddl/core` paths) mapped to UTF-8 text files. Folders are implicit (derived from paths),
 * except that providers may report empty folders via `listFolders`.
 *
 * Every write returns an opaque `version` (content hash for local-fs, ETag for S3). Passing
 * `ifMatch` makes the write conditional (optimistic concurrency); `ifMatch: null` means
 * "create only if absent". Violations throw `ConflictError`.
 */
import type { Unsubscribe } from "@ddl/core";

export type StorageProviderKind = "local" | "memory" | "s3" | "remote";

export interface FileEntry {
  path: string;
  size: number;
  /** Epoch ms. */
  mtime: number;
  version: string;
}

export interface FileContent extends FileEntry {
  content: string;
}

export interface WriteOptions {
  /**
   * Conditional write. A string requires the current version to equal it; `null` requires the file
   * to not exist. Omit for an unconditional write.
   */
  ifMatch?: string | null;
}

export interface WriteResult {
  path: string;
  version: string;
  mtime: number;
  size: number;
  /** True when the file did not exist before this write. */
  created: boolean;
}

export type StorageEventKind = "created" | "modified" | "deleted";

export interface StorageEvent {
  kind: StorageEventKind;
  path: string;
  /** New version for created/modified. */
  version?: string;
  /**
   * True when the change came from this provider instance's own write/delete/rename (so callers can
   * tell user/agent writes made through the app apart from external edits, e.g. in Obsidian).
   */
  self: boolean;
}

export interface ListOptions {
  /** Only paths under this folder (vault-relative, no trailing slash). */
  prefix?: string;
  /** Include hidden paths (dot-segments such as `.daily-do-list/`). Default false. */
  includeHidden?: boolean;
}

export interface StorageCapabilities {
  /** Emits change events for external modifications. */
  watch: boolean;
  /** Writes are atomic (readers never observe partial content). */
  atomicWrites: boolean;
  /** Supports empty folders. */
  folders: boolean;
}

export interface StorageProvider {
  readonly kind: StorageProviderKind;
  /** Stable identifier for this provider instance (used e.g. to key sync state). */
  readonly id: string;
  /** Human-readable name (vault folder name, bucket/prefix, …). */
  readonly displayName: string;
  readonly capabilities: StorageCapabilities;

  list(options?: ListOptions): Promise<FileEntry[]>;
  listFolders(options?: ListOptions): Promise<string[]>;
  stat(path: string): Promise<FileEntry | null>;
  read(path: string): Promise<FileContent | null>;
  write(path: string, content: string, options?: WriteOptions): Promise<WriteResult>;
  /**
   * Adds `content` at the end of a file, creating it if missing, without rewriting what is there
   * (append-only journals). `ifMatch` as for `write`. Optional: callers fall back to read + write
   * (`appendToFile`). Not atomic: a crash can cut the appended text short.
   */
  append?(path: string, content: string, options?: WriteOptions): Promise<WriteResult>;
  delete(path: string, options?: WriteOptions): Promise<void>;
  /** Renames a file. Fails with `ConflictError` if `to` exists. */
  rename(from: string, to: string): Promise<WriteResult>;
  createFolder(path: string): Promise<void>;
  /** Permanently deletes a folder and everything in it (emits `deleted` for each file). */
  deleteFolder(path: string): Promise<void>;
  /** Subscribe to changes. Providers without `capabilities.watch` only emit `self` events. */
  watch(listener: (event: StorageEvent) => void): Unsubscribe;
  dispose(): Promise<void>;
}

export class StorageError extends Error {
  readonly path: string | undefined;

  constructor(message: string, path?: string) {
    super(message);
    this.name = "StorageError";
    this.path = path;
  }
}

export class ConflictError extends StorageError {
  readonly currentVersion: string | null;

  constructor(path: string, currentVersion: string | null) {
    super(`Version conflict for "${path}"`, path);
    this.name = "ConflictError";
    this.currentVersion = currentVersion;
  }
}

export class NotFoundError extends StorageError {
  constructor(path: string) {
    super(`Not found: "${path}"`, path);
    this.name = "NotFoundError";
  }
}

/**
 * The sync service refused a change to one of the agent's files: it wasn't made under the current
 * agent lease grant from this device (`stale_lease`).
 */
export class StaleLeaseError extends StorageError {
  /** The current grant's epoch, or null when nobody holds the agent lease. */
  readonly currentEpoch: number | null;

  constructor(path: string, message: string, currentEpoch: number | null) {
    super(message, path);
    this.name = "StaleLeaseError";
    this.currentEpoch = currentEpoch;
  }
}

/**
 * Fencing of the agent's files on the sync service: only the device holding the agent lease may
 * change them, and it proves that with the grant's epoch (`LEASE_EPOCH_HEADER` in `@ddl/core`).
 */
export interface LeaseFence {
  /** Paths only the lease holder may change on the target. */
  covers(path: string): boolean;
  /** The epoch of the agent lease grant this device holds now, or null when it holds none. */
  epoch(): number | null;
}

export class NotImplementedError extends StorageError {
  constructor(feature: string) {
    super(`Not implemented yet: ${feature}`);
    this.name = "NotImplementedError";
  }
}

// ── Provider configuration (discriminated by `kind`) ───────────────────────

export interface LocalStorageConfig {
  kind: "local";
  /** Absolute path to the vault root folder. */
  root: string;
  /** Extra glob-free path prefixes to ignore when watching/listing (e.g. `.trash`). */
  ignore?: string[];
  /** Where the version memo is kept between runs (see `LocalFsStorageOptions.versionCache`). */
  versionCache?: string;
}

export interface MemoryStorageConfig {
  kind: "memory";
  id?: string;
  initialFiles?: Record<string, string>;
}

export interface S3StorageConfig {
  kind: "s3";
  bucket: string;
  /** Key prefix acting as the vault root, e.g. `vaults/personal/`. */
  prefix?: string;
  region?: string;
  /** Custom endpoint for S3-compatible stores (R2, MinIO, …). */
  endpoint?: string;
  /** Credentials come from the standard AWS provider chain unless a profile is given. */
  profile?: string;
  forcePathStyle?: boolean;
}

export type StorageConfig = LocalStorageConfig | MemoryStorageConfig | S3StorageConfig;

/** A vault on the sync service (`apps/sync`). Only ever a sync target, never the vault itself. */
export interface RemoteStorageConfig {
  kind: "remote";
  /** Base URL of the sync server, e.g. `https://sync.example.com`. */
  url: string;
  /** Vault id on that server. */
  vault: string;
  /** The vault's bearer token. Never logged. */
  token: string;
  /** Stable id of this device, recorded on every change it makes. */
  deviceId: string;
  /** Shown to other devices (e.g. which one runs the agent). */
  deviceName: string;
}

// ── Sync ───────────────────────────────────────────────────────────────────

export type SyncTargetConfig =
  | { kind: "none" }
  /** Mirror to another local folder (e.g. an iCloud Drive/Dropbox folder for cross-device sync). */
  | { kind: "local"; root: string }
  | ({ kind: "s3" } & Omit<S3StorageConfig, "kind">)
  /** The sync service: live push between devices and the agent lease. */
  | RemoteStorageConfig;

export type SyncState = "idle" | "syncing" | "error" | "disabled";

export interface SyncStatus {
  state: SyncState;
  target: SyncTargetConfig["kind"];
  lastSyncedAt: number | null;
  lastError?: string;
  pendingChanges: number;
  conflicts: string[];
}

export interface SyncReport {
  pushed: string[];
  pulled: string[];
  deletedLocal: string[];
  deletedRemote: string[];
  merged: string[];
  /** Conflict copies created, as `{ path, conflictPath }`. */
  conflicts: Array<{ path: string; conflictPath: string }>;
  durationMs: number;
}
