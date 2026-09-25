import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import {
  ancestorFolders,
  createId,
  type SyncChange,
  type SyncChangesResponse,
  type SyncErrorCode,
  type SyncFileEntry,
  type SyncLeaseHolder,
  type SyncLeaseName,
  type SyncLeasePriority,
  type SyncLeaseRequest,
} from "@ddl/core";
import { generateToken, hashToken, sameHash } from "./tokens";

/** Bumped with every schema change; `migrate` upgrades older databases in place. */
const SCHEMA_VERSION = 3;
const MAX_VAULT_NAME_LENGTH = 100;

const SCHEMA = `
CREATE TABLE vaults (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  last_seq INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE files (
  vault TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  rev TEXT NOT NULL,
  content TEXT NOT NULL,
  hash TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  updated_by TEXT,
  PRIMARY KEY (vault, path)
) STRICT;

CREATE TABLE folders (
  vault TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  PRIMARY KEY (vault, path)
) STRICT, WITHOUT ROWID;

CREATE TABLE changes (
  vault TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  path TEXT NOT NULL,
  rev TEXT,
  deleted INTEGER NOT NULL,
  created INTEGER NOT NULL,
  device TEXT,
  at INTEGER NOT NULL,
  PRIMARY KEY (vault, seq)
) STRICT, WITHOUT ROWID;

CREATE TABLE leases (
  vault TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  device TEXT NOT NULL,
  device_name TEXT NOT NULL,
  session TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  priority TEXT NOT NULL DEFAULT 'interactive',
  epoch INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (vault, name)
) STRICT, WITHOUT ROWID;
`;

/** `MIGRATIONS[n - 1]` upgrades a schema `n` database to `n + 1`. */
const MIGRATIONS = [
  "ALTER TABLE leases ADD COLUMN priority TEXT NOT NULL DEFAULT 'interactive'",
  // A lease held during the upgrade becomes grant 1.
  "ALTER TABLE leases ADD COLUMN epoch INTEGER NOT NULL DEFAULT 1",
] as const;

export interface VaultInfo {
  id: string;
  name: string;
  createdAt: number;
  /** The vault's latest change. */
  lastSeq: number;
  files: number;
  bytes: number;
}

export interface StoredFile extends SyncFileEntry {
  content: string;
}

export interface WriteOutcome {
  entry: SyncFileEntry;
  created: boolean;
  /** Null when the content was already identical (nothing changed). */
  change: SyncChange | null;
}

export type LeaseOutcome =
  | { ok: true; holder: SyncLeaseHolder }
  | { ok: false; holder: SyncLeaseHolder };

/** An operation that the vault's current state refuses (a precondition, a file in the way, …). */
export class VaultStateError extends Error {
  readonly code: SyncErrorCode;
  readonly currentRev: string | null | undefined;
  readonly holder: SyncLeaseHolder | undefined;

  constructor(
    code: SyncErrorCode,
    message: string,
    details: { currentRev?: string | null; holder?: SyncLeaseHolder } = {},
  ) {
    super(message);
    this.name = "VaultStateError";
    this.code = code;
    this.currentRev = details.currentRev;
    this.holder = details.holder;
  }
}

export interface SyncStoreOptions {
  now?: () => number;
  /** Total bytes of live file content a vault may hold. Default: unlimited. */
  quotaBytes?: number;
}

type Row = Record<string, unknown>;

/**
 * The sync service's database: per vault, the live files, the folders, an append-only change log
 * and leases, in one SQLite file (`:memory:` for tests). Every mutation runs in one transaction
 * that also appends its changes, so the log and the files never disagree. The service runs in a
 * single Node process: statements are synchronous, so one request's checks and writes can't
 * interleave with another's, and `BEGIN IMMEDIATE` keeps the admin CLI's writes apart.
 */
export class SyncStore {
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  readonly #quotaBytes: number;
  readonly #statements = new Map<string, StatementSync>();
  /** Compared against when a vault doesn't exist, so the answer takes as long as a wrong token. */
  readonly #decoyHash = randomBytes(32);

  constructor(filename: string, options: SyncStoreOptions = {}) {
    // Loaded here rather than imported, so the CLI can quiet its experimental warning first.
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
    this.#db = new DatabaseSync(filename);
    this.#now = options.now ?? Date.now;
    this.#quotaBytes = options.quotaBytes ?? Number.POSITIVE_INFINITY;
    this.#db.exec("PRAGMA busy_timeout = 5000");
    this.#db.exec("PRAGMA foreign_keys = ON");
    if (filename !== ":memory:") {
      this.#db.exec("PRAGMA journal_mode = WAL");
      // An accepted write must survive a power cut: clients drop their copy of what they pushed.
      this.#db.exec("PRAGMA synchronous = FULL");
    }
    this.#migrate();
  }

  close(): void {
    if (this.#db.isOpen) this.#db.close();
  }

  // ── Vaults ───────────────────────────────────────────────────────────────

  /** Creates a vault and returns its id with a new token (the only time the token is seen). */
  createVault(name: string): { vault: VaultInfo; token: string } {
    const trimmed = validVaultName(name);
    const token = generateToken();
    const id = createId("v", 20);
    const createdAt = this.#now();
    this.#run(
      "INSERT INTO vaults (id, name, token_hash, created_at, last_seq) VALUES (?, ?, ?, ?, 0)",
      id,
      trimmed,
      hashToken(token),
      createdAt,
    );
    return { vault: { id, name: trimmed, createdAt, lastSeq: 0, files: 0, bytes: 0 }, token };
  }

  /** Replaces a vault's token. The old one stops working at once (open streams are closed). */
  rotateToken(vault: string): string {
    const token = generateToken();
    const { changes } = this.#run(
      "UPDATE vaults SET token_hash = ? WHERE id = ?",
      hashToken(token),
      vault,
    );
    if (Number(changes) === 0) throw new Error(`No vault with id "${vault}"`);
    return token;
  }

  listVaults(): VaultInfo[] {
    return this.#all(
      `SELECT v.id, v.name, v.created_at, v.last_seq,
              COUNT(f.path) AS files, COALESCE(SUM(f.size), 0) AS bytes
         FROM vaults v LEFT JOIN files f ON f.vault = v.id
        GROUP BY v.id ORDER BY v.created_at, v.id`,
    ).map((row) => ({
      id: String(row.id),
      name: String(row.name),
      createdAt: Number(row.created_at),
      lastSeq: Number(row.last_seq),
      files: Number(row.files),
      bytes: Number(row.bytes),
    }));
  }

  /**
   * The stored hash of `token` when it is the token of `vault`, else null. Takes the same time
   * whether the vault is unknown or the token wrong.
   */
  authenticate(vault: string, token: string): Uint8Array | null {
    const stored = this.#tokenHash(vault);
    const candidate = hashToken(token);
    const matches = sameHash(candidate, stored ?? this.#decoyHash);
    return matches && stored ? stored : null;
  }

  /** False once the vault's token changed (or the vault is gone) since `hash` was checked. */
  isCurrentToken(vault: string, hash: Uint8Array): boolean {
    const stored = this.#tokenHash(vault);
    return stored !== null && sameHash(stored, hash);
  }

  latestSeq(vault: string): number {
    return Number(this.#get("SELECT last_seq FROM vaults WHERE id = ?", vault)?.last_seq ?? 0);
  }

  // ── Files ────────────────────────────────────────────────────────────────

  /** Live files under `prefix` (the path itself or anything inside it; all when empty). */
  listFiles(vault: string, prefix: string): { files: SyncFileEntry[]; seq: number } {
    const rows = prefix
      ? this.#all(
          `SELECT path, rev, hash, size, mtime FROM files
            WHERE vault = ? AND (path = ? OR (path >= ? AND path < ?)) ORDER BY path`,
          vault,
          ...prefixRange(prefix),
        )
      : this.#all(
          "SELECT path, rev, hash, size, mtime FROM files WHERE vault = ? ORDER BY path",
          vault,
        );
    return { files: rows.map(toEntry), seq: this.latestSeq(vault) };
  }

  stat(vault: string, path: string): SyncFileEntry | null {
    const row = this.#get(
      "SELECT path, rev, hash, size, mtime FROM files WHERE vault = ? AND path = ?",
      vault,
      path,
    );
    return row ? toEntry(row) : null;
  }

  read(vault: string, path: string): StoredFile | null {
    const row = this.#get(
      "SELECT path, rev, hash, size, mtime, content FROM files WHERE vault = ? AND path = ?",
      vault,
      path,
    );
    return row ? { ...toEntry(row), content: String(row.content) } : null;
  }

  /**
   * Writes a file, like a disk would: not over a folder, not below a file, creating its folders.
   * `ifMatch`: the required current rev, `null` = must not exist, `undefined` = unconditional.
   * Identical content keeps the rev and appends nothing.
   */
  write(
    vault: string,
    path: string,
    content: string,
    ifMatch: string | null | undefined,
    device: string,
  ): WriteOutcome {
    const text = wellFormed(content);
    const hash = sha256(text);
    const size = Buffer.byteLength(text, "utf8");
    return this.#transaction(() => {
      if (this.#isFolder(vault, path)) {
        throw new VaultStateError("not_a_file", `Not a file: "${path}"`);
      }
      const existing = this.stat(vault, path);
      checkPrecondition(path, existing, ifMatch);
      this.#assertCanHoldFile(vault, path);
      if (existing && existing.hash === hash) {
        return { entry: existing, created: false, change: null };
      }
      this.#checkQuota(vault, size - (existing?.size ?? 0));
      const seq = this.#nextSeq(vault);
      const at = this.#now();
      const entry: SyncFileEntry = { path, rev: `r${seq}`, size, hash, mtime: at };
      this.#run(
        `INSERT INTO files (vault, path, rev, content, hash, size, mtime, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (vault, path) DO UPDATE SET rev = excluded.rev, content = excluded.content,
           hash = excluded.hash, size = excluded.size, mtime = excluded.mtime,
           updated_by = excluded.updated_by`,
        vault,
        path,
        entry.rev,
        text,
        hash,
        size,
        at,
        device,
      );
      this.#addFolders(vault, ancestorFolders(path));
      const change = this.#appendChange(vault, seq, {
        path,
        rev: entry.rev,
        deleted: false,
        created: !existing,
        device,
        at,
      });
      return { entry, created: !existing, change };
    });
  }

  /** Deletes a file (its folders stay). `ifMatch`: the required current rev. */
  delete(vault: string, path: string, ifMatch: string | undefined, device: string): SyncChange {
    return this.#transaction(() => {
      const existing = this.stat(vault, path);
      if (!existing) {
        if (ifMatch !== undefined) throw conflict(path, null);
        throw new VaultStateError("not_found", `No file at "${path}"`);
      }
      if (ifMatch !== undefined && existing.rev !== ifMatch) throw conflict(path, existing.rev);
      this.#run("DELETE FROM files WHERE vault = ? AND path = ?", vault, path);
      return this.#appendDeletion(vault, path, device);
    });
  }

  /** Moves a file, keeping its rev, content and mtime. Never replaces an existing file. */
  rename(
    vault: string,
    from: string,
    to: string,
    device: string,
  ): { entry: SyncFileEntry; changes: SyncChange[] } {
    return this.#transaction(() => {
      const source = this.stat(vault, from);
      if (!source) throw new VaultStateError("not_found", `No file at "${from}"`);
      const target = this.stat(vault, to);
      if (target) throw conflict(to, target.rev);
      if (this.#isFolder(vault, to)) throw conflict(to, null);
      this.#assertCanHoldFile(vault, to);
      this.#run(
        "UPDATE files SET path = ?, updated_by = ? WHERE vault = ? AND path = ?",
        to,
        device,
        vault,
        from,
      );
      this.#addFolders(vault, ancestorFolders(to));
      const removed = this.#appendDeletion(vault, from, device);
      const seq = this.#nextSeq(vault);
      const added = this.#appendChange(vault, seq, {
        path: to,
        rev: source.rev,
        deleted: false,
        created: true,
        device,
        at: this.#now(),
      });
      return { entry: { ...source, path: to }, changes: [removed, added] };
    });
  }

  // ── Folders ──────────────────────────────────────────────────────────────

  listFolders(vault: string, prefix: string): string[] {
    const rows = prefix
      ? this.#all(
          `SELECT path FROM folders
            WHERE vault = ? AND (path = ? OR (path >= ? AND path < ?)) ORDER BY path`,
          vault,
          ...prefixRange(prefix),
        )
      : this.#all("SELECT path FROM folders WHERE vault = ? ORDER BY path", vault);
    return rows.map((row) => String(row.path));
  }

  /** Creates a folder and its parents. Returns false when it already existed. */
  createFolder(vault: string, path: string): boolean {
    return this.#transaction(() => {
      if (this.#isFolder(vault, path)) return false;
      if (this.stat(vault, path)) {
        throw new VaultStateError("not_a_folder", `A file already exists at "${path}"`);
      }
      this.#assertCanHoldFile(vault, path);
      this.#addFolders(vault, [...ancestorFolders(path), path]);
      return true;
    });
  }

  /** Deletes a folder, its subfolders and every file inside (one change per file). */
  deleteFolder(
    vault: string,
    path: string,
    device: string,
  ): { deleted: string[]; changes: SyncChange[] } {
    return this.#transaction(() => {
      if (this.stat(vault, path)) {
        throw new VaultStateError("not_a_folder", `"${path}" is not a folder`);
      }
      if (!this.#isFolder(vault, path)) {
        throw new VaultStateError("not_found", `No folder at "${path}"`);
      }
      const [, low, high] = prefixRange(path);
      const inside = this.#all(
        "SELECT path FROM files WHERE vault = ? AND path >= ? AND path < ? ORDER BY path",
        vault,
        low,
        high,
      ).map((row) => String(row.path));
      this.#run(
        "DELETE FROM folders WHERE vault = ? AND (path = ? OR (path >= ? AND path < ?))",
        vault,
        path,
        low,
        high,
      );
      const changes: SyncChange[] = [];
      for (const file of inside) {
        this.#run("DELETE FROM files WHERE vault = ? AND path = ?", vault, file);
        changes.push(this.#appendDeletion(vault, file, device));
      }
      return { deleted: inside, changes };
    });
  }

  // ── Change log ───────────────────────────────────────────────────────────

  changesSince(vault: string, since: number, limit: number): SyncChangesResponse {
    const rows = this.#all(
      `SELECT seq, path, rev, deleted, created, device, at FROM changes
        WHERE vault = ? AND seq > ? ORDER BY seq LIMIT ?`,
      vault,
      since,
      limit + 1,
    );
    const more = rows.length > limit;
    return {
      changes: rows.slice(0, limit).map(toChange),
      seq: this.latestSeq(vault),
      more,
    };
  }

  // ── Leases ───────────────────────────────────────────────────────────────

  /**
   * Grants the lease when it is free, expired, or already held by this device and session. A
   * renewal keeps the grant's epoch; any other grant takes the next one.
   */
  acquireLease(vault: string, name: SyncLeaseName, request: SyncLeaseRequest): LeaseOutcome {
    return this.#transaction(() => {
      const now = this.#now();
      const current = this.#leaseRow(vault, name);
      const live = current !== null && current.expiresAt > now;
      const renewal =
        live && current.device === request.device && current.session === request.session;
      if (live && !renewal) return { ok: false, holder: holderOf(current) };
      const holder: SyncLeaseHolder = {
        device: request.device,
        deviceName: request.deviceName,
        expiresAt: now + request.ttlMs,
        epoch: renewal ? current.epoch : (current?.epoch ?? 0) + 1,
        priority: request.priority ?? "interactive",
      };
      this.#run(
        `INSERT INTO leases (vault, name, device, device_name, session, expires_at, priority, epoch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (vault, name) DO UPDATE SET device = excluded.device,
           device_name = excluded.device_name, session = excluded.session,
           expires_at = excluded.expires_at, priority = excluded.priority, epoch = excluded.epoch`,
        vault,
        name,
        holder.device,
        holder.deviceName,
        request.session,
        holder.expiresAt,
        holder.priority,
        holder.epoch,
      );
      return { ok: true, holder };
    });
  }

  /**
   * Releases the lease if this device and session hold it; a free or expired lease is fine too.
   * The row stays (expired) so the next grant continues its epoch.
   */
  releaseLease(
    vault: string,
    name: SyncLeaseName,
    device: string,
    session: string,
  ): { ok: true } | { ok: false; holder: SyncLeaseHolder } {
    return this.#transaction(() => {
      const now = this.#now();
      const current = this.#leaseRow(vault, name);
      if (!current || current.expiresAt <= now) return { ok: true };
      if (current.device !== device || current.session !== session) {
        return { ok: false, holder: holderOf(current) };
      }
      this.#run("UPDATE leases SET expires_at = ? WHERE vault = ? AND name = ?", now, vault, name);
      return { ok: true };
    });
  }

  leaseHolder(vault: string, name: SyncLeaseName): SyncLeaseHolder | null {
    const current = this.#leaseRow(vault, name);
    return current && current.expiresAt > this.#now() ? holderOf(current) : null;
  }

  // ── Internals ────────────────────────────────────────────────────────────

  #migrate(): void {
    const version = Number(this.#get("PRAGMA user_version")?.user_version ?? 0);
    if (version > SCHEMA_VERSION) {
      throw new Error(
        `This database was created by a newer sync server (schema ${version}); upgrade the server.`,
      );
    }
    if (version === SCHEMA_VERSION) return;
    this.#transaction(() => {
      if (version === 0) this.#db.exec(SCHEMA);
      else for (const step of MIGRATIONS.slice(version - 1)) this.#db.exec(step);
      this.#db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
  }

  #transaction<T>(fn: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #statement(sql: string): StatementSync {
    let statement = this.#statements.get(sql);
    if (!statement) {
      statement = this.#db.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  #get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.#statement(sql).get(...params) as Row | undefined;
  }

  #all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.#statement(sql).all(...params) as Row[];
  }

  #run(sql: string, ...params: SQLInputValue[]) {
    return this.#statement(sql).run(...params);
  }

  #tokenHash(vault: string): Uint8Array | null {
    const value = this.#get("SELECT token_hash FROM vaults WHERE id = ?", vault)?.token_hash;
    return value instanceof Uint8Array ? value : null;
  }

  #nextSeq(vault: string): number {
    const row = this.#get(
      "UPDATE vaults SET last_seq = last_seq + 1 WHERE id = ? RETURNING last_seq",
      vault,
    );
    if (!row) throw new Error("Unknown vault");
    return Number(row.last_seq);
  }

  #appendChange(vault: string, seq: number, change: Omit<SyncChange, "seq">): SyncChange {
    this.#run(
      `INSERT INTO changes (vault, seq, path, rev, deleted, created, device, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      vault,
      seq,
      change.path,
      change.rev,
      change.deleted ? 1 : 0,
      change.created ? 1 : 0,
      change.device,
      change.at,
    );
    return { seq, ...change };
  }

  #appendDeletion(vault: string, path: string, device: string): SyncChange {
    return this.#appendChange(vault, this.#nextSeq(vault), {
      path,
      rev: null,
      deleted: true,
      created: false,
      device,
      at: this.#now(),
    });
  }

  #isFolder(vault: string, path: string): boolean {
    return (
      this.#get("SELECT 1 AS found FROM folders WHERE vault = ? AND path = ?", vault, path) !==
      undefined
    );
  }

  #addFolders(vault: string, paths: readonly string[]): void {
    for (const path of paths) {
      this.#run("INSERT OR IGNORE INTO folders (vault, path) VALUES (?, ?)", vault, path);
    }
  }

  /** Like a disk: no file may sit where a folder for `path` would have to be. */
  #assertCanHoldFile(vault: string, path: string): void {
    for (const folder of ancestorFolders(path)) {
      if (this.stat(vault, folder)) {
        throw new VaultStateError(
          "path_blocked",
          `Cannot create the folder for "${path}": a file is in the way`,
        );
      }
    }
  }

  #checkQuota(vault: string, growth: number): void {
    if (growth <= 0 || !Number.isFinite(this.#quotaBytes)) return;
    const used = Number(
      this.#get("SELECT COALESCE(SUM(size), 0) AS bytes FROM files WHERE vault = ?", vault)
        ?.bytes ?? 0,
    );
    if (used + growth > this.#quotaBytes) {
      throw new VaultStateError("quota_exceeded", "The vault's storage quota is exhausted");
    }
  }

  #leaseRow(vault: string, name: string): LeaseRow | null {
    const row = this.#get(
      `SELECT device, device_name, session, expires_at, priority, epoch FROM leases
       WHERE vault = ? AND name = ?`,
      vault,
      name,
    );
    return row
      ? {
          device: String(row.device),
          deviceName: String(row.device_name),
          session: String(row.session),
          expiresAt: Number(row.expires_at),
          priority: row.priority === "host" ? "host" : "interactive",
          epoch: Number(row.epoch),
        }
      : null;
  }
}

function validVaultName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > MAX_VAULT_NAME_LENGTH || /\p{Cc}/u.test(trimmed)) {
    throw new Error(
      `A vault name must be 1-${MAX_VAULT_NAME_LENGTH} characters without control characters`,
    );
  }
  return trimmed;
}

function checkPrecondition(
  path: string,
  existing: SyncFileEntry | null,
  ifMatch: string | null | undefined,
): void {
  if (ifMatch === undefined) return;
  if (ifMatch === null) {
    if (existing) throw conflict(path, existing.rev);
    return;
  }
  if (!existing || existing.rev !== ifMatch) throw conflict(path, existing?.rev ?? null);
}

function conflict(path: string, currentRev: string | null): VaultStateError {
  return new VaultStateError("conflict", `Version conflict for "${path}"`, { currentRev });
}

/** `[prefix, prefix + "/", prefix + "0"]`: in byte order, the paths inside a folder sort between. */
function prefixRange(prefix: string): [string, string, string] {
  return [prefix, `${prefix}/`, `${prefix}0`];
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** What UTF-8 storage holds: lone surrogates become U+FFFD, as every storage provider does. */
function wellFormed(text: string): string {
  return text.replace(LONE_SURROGATE, "\uFFFD");
}

function toEntry(row: Row): SyncFileEntry {
  return {
    path: String(row.path),
    rev: String(row.rev),
    size: Number(row.size),
    hash: String(row.hash),
    mtime: Number(row.mtime),
  };
}

function toChange(row: Row): SyncChange {
  return {
    seq: Number(row.seq),
    path: String(row.path),
    rev: row.rev === null ? null : String(row.rev),
    deleted: Number(row.deleted) === 1,
    created: Number(row.created) === 1,
    device: row.device === null ? null : String(row.device),
    at: Number(row.at),
  };
}

interface LeaseRow {
  device: string;
  deviceName: string;
  session: string;
  expiresAt: number;
  priority: SyncLeasePriority;
  epoch: number;
}

function holderOf(row: LeaseRow): SyncLeaseHolder {
  return {
    device: row.device,
    deviceName: row.deviceName,
    expiresAt: row.expiresAt,
    epoch: row.epoch,
    priority: row.priority,
  };
}
