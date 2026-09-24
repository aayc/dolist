import type { Dirent, Stats } from "node:fs";
import { lstat, mkdir, readdir, realpath, rename, rm, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  hashString,
  InvalidPathError,
  isHiddenPath,
  type Logger,
  normalizePath,
  silentLogger,
  type Unsubscribe,
} from "@ddl/core";
import { isBinaryPath } from "./file-types";
import { IgnoreRules } from "./ignore-rules";
import { readTextFile, writeFileAtomic } from "./internal/atomic-write";
import { ChangeTracker, type ChangeTrackerHost, type PathProbe } from "./internal/change-tracker";
import { errorCode, errorMessage, isAccessError, isMissingError } from "./internal/fs-errors";
import { KeyedMutex } from "./internal/keyed-mutex";
import { createLimiter } from "./internal/limiter";
import { RecursiveWatcher } from "./internal/recursive-watcher";
import { contentVersion } from "./memory";
import {
  ConflictError,
  type FileContent,
  type FileEntry,
  type ListOptions,
  NotFoundError,
  type StorageCapabilities,
  StorageError,
  type StorageEvent,
  type StorageProvider,
  type WriteOptions,
  type WriteResult,
} from "./types";

export interface LocalFsStorageOptions {
  /** Vault root folder. Created if missing. */
  root: string;
  /** Extra vault-relative path prefixes to skip when listing and watching. */
  ignore?: string[];
  logger?: Logger;
  /** Per-path quiet period before an external change is classified and emitted. */
  watchDebounceMs?: number;
}

/** Files above this size (and binary formats) are versioned by stat instead of content hash. */
const MAX_CONTENT_HASH_BYTES = 16 * 1024 * 1024;
/** Concurrent file reads during scans; keeps us well below the default fd limit (256 on macOS). */
const READ_CONCURRENCY = 16;

interface CachedVersion {
  mtimeMs: number;
  size: number;
  version: string;
}

interface Tracking {
  tracker: ChangeTracker;
  watcher: RecursiveWatcher | undefined;
  ready: Promise<void>;
  stopped: boolean;
}

interface WalkContext {
  includeHidden: boolean;
  onFile?: (entry: FileEntry) => void;
  onFolder?: (path: string) => void;
}

type Scope =
  | { kind: "folder"; path: string; real: string }
  | { kind: "file"; path: string; real: string };

/**
 * StorageProvider for a vault folder on disk (the default vault; works on an existing Obsidian
 * vault). Paths are vault-relative POSIX paths; anything that escapes the root, lexically or via
 * a symlink, is rejected with `InvalidPathError`.
 *
 * - Writes are atomic (temp file + rename) and conditional writes are race-free within the
 *   process (per-path mutex around check + write).
 * - Versions are content hashes (`contentVersion`), memoized by (path, mtime, size) so listing an
 *   unchanged vault doesn't re-read files. Binary formats and files over 16 MiB get a stat-based
 *   version instead: they can't round-trip through this text API, and hashing them would make the
 *   first listing of an attachment-heavy vault crawl.
 * - `watch` starts a recursive fs watcher on first subscription. Own writes emit `self: true`
 *   events immediately; external changes emit `self: false` after a short per-path debounce.
 * - `.git`, `node_modules`, `.trash`, `.DS_Store`, editor temp files and our own temp files are
 *   never listed or watched. Symlinked files inside the vault are followed; symlinked folders are
 *   not (they would list files twice or loop).
 */
export class LocalFsStorageProvider implements StorageProvider {
  readonly kind = "local" as const;
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: StorageCapabilities = { watch: true, atomicWrites: true, folders: true };
  /** Absolute vault root as configured. */
  readonly root: string;

  private readonly rules: IgnoreRules;
  private readonly logger: Logger;
  private readonly debounceMs: number;
  private readonly locks = new KeyedMutex();
  private readonly readLimit = createLimiter(READ_CONCURRENCY);
  private readonly versions = new Map<string, CachedVersion>();
  private readonly listeners = new Set<(event: StorageEvent) => void>();
  private realRoot: Promise<string> | undefined;
  private tracking: Tracking | undefined;
  private stopping: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(options: LocalFsStorageOptions) {
    this.root = resolve(options.root);
    this.id = `local-${hashString(this.root)}`;
    this.displayName = basename(this.root) || this.root;
    this.rules = new IgnoreRules(options.ignore);
    this.logger = (options.logger ?? silentLogger).child({ component: "storage.local" });
    this.debounceMs = options.watchDebounceMs ?? 50;
  }

  /** Creates the vault folder if needed and resolves its real path. Idempotent. */
  async init(): Promise<void> {
    await this.rootPath();
  }

  /** Resolves once the watcher has scanned the vault (immediately when nobody is watching). */
  async whenWatchReady(): Promise<void> {
    await this.tracking?.ready;
  }

  async list(options: ListOptions = {}): Promise<FileEntry[]> {
    const root = await this.rootPath();
    const scope = await this.scope(root, options);
    if (!scope) return [];
    const files: FileEntry[] = [];
    if (scope.kind === "file") {
      const entry = await this.entryFor(scope.path, scope.real);
      if (entry) files.push(entry);
    } else {
      await this.walk(root, scope.real, scope.path, {
        includeHidden: options.includeHidden === true,
        onFile: (entry) => files.push(entry),
      });
    }
    return files.sort((a, b) => comparePaths(a.path, b.path));
  }

  async listFolders(options: ListOptions = {}): Promise<string[]> {
    const root = await this.rootPath();
    const scope = await this.scope(root, options);
    if (!scope || scope.kind === "file") return [];
    const folders = scope.path ? [scope.path] : [];
    await this.walk(root, scope.real, scope.path, {
      includeHidden: options.includeHidden === true,
      onFolder: (path) => folders.push(path),
    });
    return folders.sort(comparePaths);
  }

  async stat(path: string): Promise<FileEntry | null> {
    const p = toVaultPath(path);
    const root = await this.rootPath();
    const { real } = await this.locate(root, p);
    return real ? this.entryFor(p, real) : null;
  }

  async read(path: string): Promise<FileContent | null> {
    const p = toVaultPath(path);
    const root = await this.rootPath();
    const { real } = await this.locate(root, p);
    if (!real) return null;
    const loaded = await this.readLimit(() => readTextFile(real));
    if (!loaded) return null;
    const version = this.remember(p, loaded.stats, loaded.content);
    return {
      path: p,
      size: loaded.stats.size,
      mtime: toEpochMs(loaded.stats),
      version,
      content: loaded.content,
    };
  }

  async write(path: string, content: string, options: WriteOptions = {}): Promise<WriteResult> {
    const p = toVaultPath(path);
    const root = await this.rootPath();
    return this.locks.run(p, async () => {
      const { abs, real } = await this.locate(root, p);
      // Writing through a symlinked file updates its target instead of replacing the link.
      const target = real ?? abs;
      const before = real ? await statOrNull(real) : null;
      if (before && !before.isFile()) throw new StorageError(`Not a file: "${p}"`, p);
      if (options.ifMatch !== undefined) {
        const current = before ? await this.currentVersion(p, target) : null;
        const ok = options.ifMatch === null ? current === null : current === options.ifMatch;
        if (!ok) throw new ConflictError(p, current);
      }
      await this.ensureFolder(dirname(target), p);
      const stats = await writeFileAtomic(
        target,
        content,
        before ? before.mode & 0o7777 : undefined,
      );
      const version = this.remember(p, stats, content);
      this.tracking?.tracker.recordSelf(p, version);
      this.emit({ kind: before ? "modified" : "created", path: p, version, self: true });
      return { path: p, version, mtime: toEpochMs(stats), size: stats.size, created: !before };
    });
  }

  async delete(path: string, options: WriteOptions = {}): Promise<void> {
    const p = toVaultPath(path);
    const root = await this.rootPath();
    await this.locks.run(p, async () => {
      const { abs, real } = await this.locate(root, p);
      const before = real ? await statOrNull(real) : null;
      if (!real || !before?.isFile()) {
        if (typeof options.ifMatch === "string") throw new ConflictError(p, null);
        throw new NotFoundError(p);
      }
      if (options.ifMatch !== undefined) {
        const current = await this.currentVersion(p, real);
        if (options.ifMatch === null || current !== options.ifMatch) {
          throw new ConflictError(p, current);
        }
      }
      try {
        // `abs`, not `real`: deleting a symlinked file removes the link, not its target.
        await unlink(abs);
      } catch (error) {
        if (isMissingError(error)) throw new NotFoundError(p);
        throw error;
      }
      this.versions.delete(p);
      this.tracking?.tracker.recordSelf(p, null);
      this.emit({ kind: "deleted", path: p, self: true });
    });
  }

  async rename(from: string, to: string): Promise<WriteResult> {
    const src = toVaultPath(from);
    const dst = toVaultPath(to);
    const root = await this.rootPath();
    return this.locks.runAll([src, dst], async () => {
      const source = await this.locate(root, src);
      const srcStats = source.real ? await statOrNull(source.real) : null;
      if (!srcStats?.isFile()) throw new NotFoundError(src);
      const dest = await this.locate(root, dst);
      const dstStats = dest.real ? await statOrNull(dest.real) : null;
      if (dstStats && !isCaseOnlyRename(src, dst, srcStats, dstStats)) {
        const current =
          dstStats.isFile() && dest.real ? await this.currentVersion(dst, dest.real) : null;
        throw new ConflictError(dst, current);
      }
      await this.ensureFolder(dirname(dest.abs), dst);
      await rename(source.abs, dest.abs);

      const cached = this.versions.get(src);
      this.versions.delete(src);
      if (cached) this.versions.set(dst, cached);
      this.tracking?.tracker.recordSelf(src, null);
      this.emit({ kind: "deleted", path: src, self: true });
      const moved = await statOrNull(dest.abs);
      const resolved = moved ? await this.versionFor(dst, dest.abs, moved) : null;
      if (!resolved) {
        // A relative symlink moved to another folder no longer resolves.
        throw new StorageError(`"${dst}" is a symlink that no longer resolves after the move`, dst);
      }
      this.tracking?.tracker.recordSelf(dst, resolved.version);
      this.emit({ kind: "created", path: dst, version: resolved.version, self: true });
      return {
        path: dst,
        version: resolved.version,
        mtime: toEpochMs(resolved.stats),
        size: resolved.stats.size,
        created: true,
      };
    });
  }

  async createFolder(path: string): Promise<void> {
    const p = toVaultPath(path);
    const root = await this.rootPath();
    const { abs, real } = await this.locate(root, p);
    if (real) {
      if ((await statOrNull(real))?.isDirectory()) return;
      throw new StorageError(`A file already exists at "${p}"`, p);
    }
    await this.ensureFolder(abs, p);
  }

  async deleteFolder(path: string): Promise<void> {
    const p = toVaultPath(path);
    if (p === "") throw new StorageError("Refusing to delete the vault root");
    const root = await this.rootPath();
    const { abs, real } = await this.locate(root, p);
    const stats = real ? await statOrNull(real) : null;
    if (!stats) throw new NotFoundError(p);
    if (!stats.isDirectory()) throw new StorageError(`"${p}" is not a folder`, p);
    // File by file first, so locks, the version cache and self events stay consistent.
    for (const file of await this.list({ prefix: p, includeHidden: true })) {
      await this.delete(file.path).catch((error: unknown) => {
        if (!(error instanceof NotFoundError)) throw error;
      });
    }
    // Then whatever listing skips (ignored files, empty folders). `abs` removes a link, not its target.
    await rm(abs, { recursive: true, force: true });
  }

  watch(listener: (event: StorageEvent) => void): Unsubscribe {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    if (!this.tracking) this.startTracking();
    return () => {
      if (!this.listeners.delete(listener)) return;
      if (this.listeners.size === 0) void this.stopTracking();
    };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.listeners.clear();
    await this.stopTracking();
  }

  // ── Paths ────────────────────────────────────────────────────────────────

  private rootPath(): Promise<string> {
    this.realRoot ??= this.openRoot().catch((error: unknown) => {
      this.realRoot = undefined;
      throw error;
    });
    return this.realRoot;
  }

  private async openRoot(): Promise<string> {
    try {
      await mkdir(this.root, { recursive: true });
      const real = await realpath(this.root);
      if (!(await stat(real)).isDirectory()) throw new Error("not a folder");
      return real;
    } catch (error) {
      throw new StorageError(
        `Cannot open vault folder "${this.displayName}": ${errorMessage(error)}`,
      );
    }
  }

  /**
   * Maps a vault path to its absolute path and, when it exists, its real path. Throws
   * `InvalidPathError` if the path (or, for new files, its closest existing folder) resolves
   * outside the vault through a symlink.
   */
  private async locate(root: string, p: string): Promise<{ abs: string; real: string | null }> {
    const abs = join(root, ...p.split("/"));
    try {
      const real = await realpath(abs);
      if (!isInside(root, real)) throw new InvalidPathError(p, "resolves outside the vault");
      return { abs, real };
    } catch (error) {
      if (!isMissingError(error)) throw error;
    }
    for (let dir = dirname(abs); dir.length > root.length; dir = dirname(dir)) {
      try {
        const real = await realpath(dir);
        if (!isInside(root, real)) throw new InvalidPathError(p, "resolves outside the vault");
        break;
      } catch (error) {
        if (!isMissingError(error)) throw error;
      }
    }
    return { abs, real: null };
  }

  private async scope(root: string, options: ListOptions): Promise<Scope | null> {
    const prefix = options.prefix ? normalizePath(options.prefix) : "";
    if (prefix === "") return { kind: "folder", path: "", real: root };
    if (!options.includeHidden && isHiddenPath(prefix)) return null;
    if (this.rules.isIgnored(prefix)) return null;
    const { real } = await this.locate(root, prefix);
    const stats = real ? await statOrNull(real) : null;
    if (!real || !stats) return null;
    if (stats.isDirectory()) return { kind: "folder", path: prefix, real };
    if (stats.isFile()) return { kind: "file", path: prefix, real };
    return null;
  }

  private async ensureFolder(absFolder: string, p: string): Promise<void> {
    try {
      await mkdir(absFolder, { recursive: true });
    } catch (error) {
      const code = errorCode(error);
      if (code === "EEXIST" || code === "ENOTDIR") {
        throw new StorageError(`Cannot create the folder for "${p}": a file is in the way`, p);
      }
      throw error;
    }
  }

  // ── Listing & versions ───────────────────────────────────────────────────

  private async walk(
    root: string,
    dirAbs: string,
    dirRel: string,
    ctx: WalkContext,
  ): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(dirAbs, { withFileTypes: true });
    } catch (error) {
      if (isMissingError(error) || isAccessError(error)) {
        this.logger.debug("skipping unreadable folder", { path: dirRel, error: errorCode(error) });
        return;
      }
      throw error;
    }
    const pending: Promise<void>[] = [];
    for (const entry of entries) {
      const name = entry.name;
      // A backslash is a separator in vault paths, so such a file can't be addressed.
      if (name.includes("\\")) continue;
      if (!ctx.includeHidden && name.startsWith(".")) continue;
      const rel = dirRel ? `${dirRel}/${name}` : name;
      if (this.rules.isIgnored(rel)) continue;
      const abs = join(dirAbs, name);
      if (entry.isDirectory()) {
        ctx.onFolder?.(rel);
        pending.push(this.walk(root, abs, rel, ctx));
      } else if (entry.isFile()) {
        if (ctx.onFile) pending.push(this.visitFile(rel, abs, ctx.onFile));
      } else if (entry.isSymbolicLink() && ctx.onFile) {
        pending.push(this.visitSymlink(root, rel, abs, ctx.onFile));
      }
    }
    await Promise.all(pending);
  }

  private async visitFile(
    p: string,
    abs: string,
    onFile: (entry: FileEntry) => void,
    stats?: Stats,
  ): Promise<void> {
    const entry = await this.entryFor(p, abs, stats);
    if (entry) onFile(entry);
  }

  private async visitSymlink(
    root: string,
    p: string,
    abs: string,
    onFile: (entry: FileEntry) => void,
  ): Promise<void> {
    let real: string;
    try {
      real = await realpath(abs);
    } catch {
      return; // dangling link
    }
    if (!isInside(root, real)) {
      this.logger.debug("skipping symlink that points outside the vault", { path: p });
      return;
    }
    const stats = await statOrNull(real);
    if (stats?.isFile()) await this.visitFile(p, real, onFile, stats);
  }

  private async entryFor(p: string, abs: string, known?: Stats): Promise<FileEntry | null> {
    const stats = known ?? (await statOrNull(abs));
    if (!stats?.isFile()) return null;
    const resolved = await this.versionFor(p, abs, stats);
    if (!resolved) return null;
    return {
      path: p,
      size: resolved.stats.size,
      mtime: toEpochMs(resolved.stats),
      version: resolved.version,
    };
  }

  /** Version from the (path, mtime, size) memo, reading the file only on a miss. */
  private async versionFor(
    p: string,
    abs: string,
    stats: Stats,
  ): Promise<{ version: string; stats: Stats } | null> {
    const cached = this.versions.get(p);
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
      return { version: cached.version, stats };
    }
    if (usesStatVersion(p, stats.size)) return { version: this.rememberStat(p, stats), stats };
    const loaded = await this.readLimit(() => readTextFile(abs));
    if (!loaded) return null;
    return { version: this.remember(p, loaded.stats, loaded.content), stats: loaded.stats };
  }

  /** Version straight from disk, bypassing the memo (for preconditions and change detection). */
  private async currentVersion(p: string, real: string): Promise<string | null> {
    const stats = await statOrNull(real);
    if (!stats?.isFile()) return null;
    if (usesStatVersion(p, stats.size)) return this.rememberStat(p, stats);
    const loaded = await this.readLimit(() => readTextFile(real));
    return loaded ? this.remember(p, loaded.stats, loaded.content) : null;
  }

  private remember(p: string, stats: Stats, content: string): string {
    if (usesStatVersion(p, stats.size)) return this.rememberStat(p, stats);
    const version = contentVersion(content);
    this.versions.set(p, { mtimeMs: stats.mtimeMs, size: stats.size, version });
    return version;
  }

  private rememberStat(p: string, stats: Stats): string {
    const version = hashString(`stat:${stats.size}:${stats.mtimeMs}`);
    this.versions.set(p, { mtimeMs: stats.mtimeMs, size: stats.size, version });
    return version;
  }

  // ── Watching ─────────────────────────────────────────────────────────────

  private startTracking(): void {
    const tracker = new ChangeTracker(this.trackerHost(), {
      debounceMs: this.debounceMs,
      deleteGraceMs: this.debounceMs * 2,
      logger: this.logger,
    });
    const tracking: Tracking = {
      tracker,
      watcher: undefined,
      ready: Promise.resolve(),
      stopped: false,
    };
    tracking.ready = (async () => {
      const root = await this.rootPath();
      if (tracking.stopped) return;
      const watcher = new RecursiveWatcher({
        root,
        logger: this.logger,
        onChange: (path) => {
          if (!this.rules.isIgnored(path)) tracker.notify(path);
        },
        onRescan: () => tracker.requestRescan(),
      });
      tracking.watcher = watcher;
      // Watch before the baseline scan so nothing slips in between.
      watcher.start();
      await tracker.start();
    })().catch((error: unknown) => {
      this.logger.error("could not start watching the vault", { error: errorMessage(error) });
    });
    this.tracking = tracking;
  }

  private stopTracking(): Promise<void> {
    const tracking = this.tracking;
    if (!tracking) return this.stopping;
    this.tracking = undefined;
    tracking.stopped = true;
    this.stopping = (async () => {
      await tracking.ready;
      tracking.watcher?.close();
      await tracking.tracker.stop();
    })();
    return this.stopping;
  }

  private trackerHost(): ChangeTrackerHost {
    return {
      probe: (path) => this.probe(path),
      listFiles: async (prefix) => {
        const entries = await this.list({ prefix, includeHidden: true });
        return new Map(entries.map((entry) => [entry.path, entry.version]));
      },
      withLock: (path, fn) => this.locks.run(path, fn),
      emit: (event) => this.emit(event),
    };
  }

  private async probe(p: string): Promise<PathProbe> {
    const root = await this.rootPath();
    let located: { abs: string; real: string | null };
    try {
      located = await this.locate(root, p);
    } catch (error) {
      if (error instanceof InvalidPathError) return { type: "missing" };
      throw error;
    }
    if (!located.real) return { type: "missing" };
    const stats = await statOrNull(located.real);
    if (!stats) return { type: "missing" };
    if (stats.isDirectory()) {
      const link = await lstatOrNull(located.abs);
      return link?.isSymbolicLink() ? { type: "missing" } : { type: "directory" };
    }
    if (!stats.isFile()) return { type: "missing" };
    const version = await this.currentVersion(p, located.real);
    return version === null ? { type: "missing" } : { type: "file", version };
  }

  private emit(event: StorageEvent): void {
    if (this.disposed || this.rules.isIgnored(event.path)) return;
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.logger.error("storage event listener threw", { error: errorMessage(error) });
      }
    }
  }
}

function toVaultPath(input: string): string {
  const p = normalizePath(input);
  if (p === "") throw new InvalidPathError(input, "is empty");
  return p;
}

function isInside(root: string, real: string): boolean {
  if (real === root) return true;
  return real.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

function usesStatVersion(p: string, size: number): boolean {
  return size > MAX_CONTENT_HASH_BYTES || isBinaryPath(p);
}

/** `Note.md` → `note.md` on a case-insensitive disk: same file, so not a conflict. */
function isCaseOnlyRename(src: string, dst: string, a: Stats, b: Stats): boolean {
  return (
    src !== dst && src.toLowerCase() === dst.toLowerCase() && a.dev === b.dev && a.ino === b.ino
  );
}

function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function toEpochMs(stats: Stats): number {
  return Math.floor(stats.mtimeMs);
}

async function statOrNull(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch (error) {
    if (isMissingError(error)) return null;
    throw error;
  }
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissingError(error)) return null;
    throw error;
  }
}
