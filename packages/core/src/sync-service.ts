/**
 * Wire protocol of the sync service (`apps/sync`): the HTTP API and WebSocket stream that several
 * devices use to share one vault. The server, the storage client (`RemoteStorageProvider` in
 * `@ddl/storage`) and future native clients all build on these types, as `protocol.ts` is for
 * the daemon. Changes must be additive within `SYNC_API_VERSION`.
 *
 * Transport: JSON under `/v1`, over HTTPS in production. Every vault route needs
 * `Authorization: Bearer <token>`; a token authorizes exactly one vault, and a wrong token, an
 * unknown vault and another vault's token all get the same 401. Mutating requests name the device
 * in `X-DDL-Device`, which the server records on the change.
 *
 * Content is opaque to the server: it stores and returns it as sent (after replacing lone
 * surrogates, like every provider) and never merges, so end-to-end encryption can be layered on
 * without protocol changes.
 *
 * Revisions (`rev`) are opaque strings, unique within a vault. A write with new content gets a new
 * one; a write with identical content keeps it (and appends nothing); a rename carries it to the
 * new path. Every accepted write, delete and rename appends to the vault's change log under a
 * per-vault sequence number (`seq`) that only grows.
 */
import { encodeVaultPath } from "./protocol";

/** Major version of the sync protocol, reported by `GET /v1/health`. */
export const SYNC_API_VERSION = 1;

/** Header naming the device on mutating requests. */
export const SYNC_DEVICE_HEADER = "x-ddl-device";

/** Leases a vault can grant, one holder each. `agent`: the device that runs the agent. */
export const SYNC_LEASE_NAMES = ["agent"] as const;
export type SyncLeaseName = (typeof SYNC_LEASE_NAMES)[number];

export const SYNC_LIMITS = {
  /** Default cap on one file's content, in UTF-8 bytes (servers may configure another). */
  fileBytes: 5 * 1024 * 1024,
  /** Longest vault path, in UTF-16 code units. */
  pathLength: 4096,
  /** Longest vault id, device id or lease session. */
  idLength: 64,
  deviceNameLength: 100,
  /** Most changes one `GET …/changes` page returns. */
  changesPage: 1000,
  leaseMinTtlMs: 5_000,
  leaseMaxTtlMs: 10 * 60_000,
} as const;

/** Vault ids, device ids and lease sessions: 1–64 URL-safe characters. */
export const SYNC_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Application close codes of the stream. Authentication failures never reach it (HTTP 401). */
export const SYNC_STREAM_CLOSE_CODES = {
  shuttingDown: 1001,
  /** The vault's token was rotated while the stream was open. */
  tokenRevoked: 4401,
} as const;

const vaultRoute = (vault: string, rest: string) =>
  `/v1/vaults/${encodeURIComponent(vault)}${rest}`;

/** Route builders. Paths are vault-relative and canonical; each segment is percent-encoded. */
export const SYNC_ROUTES = {
  /** GET → SyncHealthResponse (no auth, nothing about vaults). */
  health: "/v1/health",
  /** GET (`?prefix=`) → SyncFileListResponse */
  files: (vault: string) => vaultRoute(vault, "/files"),
  /**
   * GET → SyncFileResponse (`?meta=1`: SyncFileEntry, no content) or 404 · PUT
   * SyncWriteFileRequest → SyncWriteResponse (201 created, 200 otherwise), 409 SyncConflictBody ·
   * DELETE (`?ifMatch=<rev>`) → 204, 404 or 409 SyncConflictBody
   */
  file: (vault: string, path: string) => vaultRoute(vault, `/files/${encodeVaultPath(path)}`),
  /** POST SyncRenameRequest → SyncWriteResponse (the moved file), 404 or 409 */
  rename: (vault: string) => vaultRoute(vault, "/rename"),
  /**
   * GET (`?prefix=`) → SyncFolderListResponse · POST SyncCreateFolderRequest →
   * SyncCreateFolderResponse (201 created, 200 already there) · DELETE `?path=` →
   * SyncDeleteFolderResponse
   */
  folders: (vault: string) => vaultRoute(vault, "/folders"),
  /** GET (`?since=<seq>&limit=`) → SyncChangesResponse */
  changes: (vault: string) => vaultRoute(vault, "/changes"),
  /** WebSocket upgrade → SyncStreamMessage frames */
  stream: (vault: string) => vaultRoute(vault, "/stream"),
  /**
   * GET → SyncLeaseStatusResponse · POST SyncLeaseRequest → SyncLeaseResponse or 409
   * SyncLeaseConflictBody · DELETE (`?device=&session=`) → 204 or 409 SyncLeaseConflictBody
   */
  lease: (vault: string, name: SyncLeaseName) =>
    vaultRoute(vault, `/leases/${encodeURIComponent(name)}`),
} as const;

// ── REST shapes ─────────────────────────────────────────────────────────────

export interface SyncHealthResponse {
  ok: true;
  apiVersion: number;
}

export interface SyncFileEntry {
  path: string;
  rev: string;
  /** UTF-8 bytes of the content. */
  size: number;
  /** SHA-256 of the content's UTF-8 bytes, lowercase hex. */
  hash: string;
  /** When the server accepted this content (epoch ms, server clock). */
  mtime: number;
}

export interface SyncFileListResponse {
  /** Live files in code-point order, including hidden and junk paths (clients filter). */
  files: SyncFileEntry[];
  /** The vault's latest `seq` when it was listed: the listing reflects every change up to it. */
  seq: number;
}

export interface SyncFileResponse extends SyncFileEntry {
  content: string;
}

export interface SyncWriteFileRequest {
  content: string;
  /** Required current rev; `null` = the file must not exist; omitted = unconditional. */
  ifMatch?: string | null;
}

export interface SyncWriteResponse extends SyncFileEntry {
  /** True when the path held no file before. */
  created: boolean;
  /** The change this appended, or null when the content was already identical. */
  seq: number | null;
}

export interface SyncRenameRequest {
  from: string;
  to: string;
}

export interface SyncFolderListResponse {
  /**
   * Folders in code-point order: created explicitly or by writing a file into them. Like folders
   * on a disk, they outlive their files until deleted.
   */
  folders: string[];
}

export interface SyncCreateFolderRequest {
  path: string;
}

export interface SyncCreateFolderResponse {
  path: string;
}

export interface SyncDeleteFolderResponse {
  /** The files deleted with the folder, in code-point order (one change each). */
  deleted: string[];
}

export interface SyncChange {
  seq: number;
  path: string;
  /** The new rev, or null for a deletion. */
  rev: string | null;
  deleted: boolean;
  /** True when the path held no file before (always false for deletions). */
  created: boolean;
  /** `X-DDL-Device` of the request that made the change. */
  device: string | null;
  /** Epoch ms, server clock. */
  at: number;
}

export interface SyncChangesResponse {
  /** Changes after `since`, oldest first, at most `limit`. */
  changes: SyncChange[];
  /** The vault's latest `seq`. */
  seq: number;
  /** More changes follow the last one returned. */
  more: boolean;
}

/** Frames the server pushes on `…/stream`. Clients ignore types they don't know. */
export type SyncStreamMessage =
  /** First frame: changes after `seq` are pushed from now on (catch up to it with `…/changes`). */
  | { type: "ready"; seq: number; heartbeatMs: number }
  | ({ type: "change" } & SyncChange)
  /** Every `heartbeatMs`: a client that has seen fewer changes than `seq` missed some. */
  | { type: "heartbeat"; seq: number; at: number };

/**
 * Who asks for a lease. `interactive` (a device set to run the agent itself) outranks `host` (the
 * always-on machine): a request that outranks the holder records a pending takeover, and the
 * holder is asked to yield on its next renewal. Equal priorities: first come, first served.
 */
export type SyncLeasePriority = "host" | "interactive";

export const SYNC_LEASE_PRIORITIES: readonly SyncLeasePriority[] = ["host", "interactive"];

export interface SyncLeaseRequest {
  /** Must equal the `X-DDL-Device` header. */
  device: string;
  /** Shown to other devices ("The agent is running on …"). */
  deviceName: string;
  /**
   * Random per process. Renewal needs the same device and session, so a copied device id (a
   * cloned home folder) can't hold the lease twice; a restarted process waits for the old
   * lease to be released or to expire.
   */
  session: string;
  ttlMs: number;
  /** Absent = `interactive`. */
  priority?: SyncLeasePriority;
}

export interface SyncLeaseHolder {
  device: string;
  deviceName: string;
  /** Epoch ms, server clock. */
  expiresAt: number;
  /** The priority the holder requested the lease with. */
  priority: SyncLeasePriority;
  /** A higher-priority device is waiting: stop, sync and release (answered on renewal). */
  yieldRequested?: boolean;
}

export interface SyncLeaseResponse {
  lease: SyncLeaseHolder;
}

export interface SyncLeaseStatusResponse {
  /** The current holder, or null when the lease is free or expired. */
  holder: SyncLeaseHolder | null;
}

// ── Errors ──────────────────────────────────────────────────────────────────

/** `error` codes of the sync service. Clients treat unknown codes by their HTTP status. */
export type SyncErrorCode =
  /** 400: the body is not JSON. */
  | "invalid_json"
  /** 400: body, query, header or route parameter failed validation. */
  | "invalid_request"
  /** 400: a vault path is not canonical, escapes the vault, contains NUL or is too long. */
  | "invalid_path"
  /** 401: missing or wrong token, or unknown vault (indistinguishable on purpose). */
  | "unauthorized"
  /** 404: unknown route, file or folder. */
  | "not_found"
  /** 409: `ifMatch` doesn't match (the body carries `currentRev`), or a rename target exists. */
  | "conflict"
  /** 409: the path is a folder. */
  | "not_a_file"
  /** 409: the path is a file. */
  | "not_a_folder"
  /** 409: a file sits where one of the path's folders would have to be. */
  | "path_blocked"
  /** 409: another device holds the lease (the body carries `holder`). */
  | "lease_held"
  /** 413: body or file over the size limit. */
  | "payload_too_large"
  /** 413: the write would exceed the vault's storage quota. */
  | "quota_exceeded"
  /** 426: `…/stream` requested without a WebSocket upgrade. */
  | "upgrade_required"
  /** 429: too many requests for this vault; retry after `Retry-After` seconds. */
  | "rate_limited"
  /** 500: unexpected server failure. */
  | "internal_error";

export interface SyncErrorBody {
  error: SyncErrorCode;
  message?: string;
}

export interface SyncConflictBody extends SyncErrorBody {
  error: "conflict";
  currentRev: string | null;
}

export interface SyncLeaseConflictBody extends SyncErrorBody {
  error: "lease_held";
  holder: SyncLeaseHolder;
  /** This request outranks the holder: a takeover is pending, ask again to get the lease. */
  takeoverPending?: boolean;
}
