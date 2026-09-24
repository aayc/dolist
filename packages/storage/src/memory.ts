import {
  ancestorFolders,
  createId,
  hashString,
  InvalidPathError,
  isHiddenPath,
  normalizePath,
  type Unsubscribe,
} from "@ddl/core";
import { toStorableText } from "./file-types";
import { IgnoreRules } from "./ignore-rules";
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

interface MemoryFile {
  content: string;
  mtime: number;
  version: string;
}

/** Content version shared by all providers that hash content (local-fs, memory). */
export function contentVersion(content: string): string {
  return hashString(content);
}

/**
 * In-memory provider. The reference implementation of the StorageProvider contract, used by unit
 * tests, e2e fixtures and as a sync target in tests. It behaves like a vault folder on disk
 * (`local-fs`): folders exist once something created them and outlive their files, a file and a
 * folder can't share a path, and junk/temp files (`.trash`, `node_modules`, editor backups, …) are
 * never listed or reported. `simulateExternalChange` mimics edits made by another app (emits
 * `self: false` events).
 */
export class MemoryStorageProvider implements StorageProvider {
  readonly kind = "memory" as const;
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: StorageCapabilities = { watch: true, atomicWrites: true, folders: true };

  private readonly files = new Map<string, MemoryFile>();
  private readonly folders = new Set<string>();
  private readonly listeners = new Set<(event: StorageEvent) => void>();
  private readonly rules = new IgnoreRules();
  private clock: () => number;

  constructor(
    options: {
      id?: string;
      displayName?: string;
      initialFiles?: Record<string, string>;
      now?: () => number;
    } = {},
  ) {
    this.id = options.id ?? createId("mem");
    this.displayName = options.displayName ?? "Memory vault";
    this.clock = options.now ?? Date.now;
    for (const [path, content] of Object.entries(options.initialFiles ?? {})) {
      const p = toVaultPath(path);
      this.assertCanHoldFile(p);
      this.store(p, content);
    }
  }

  async list(options: ListOptions = {}): Promise<FileEntry[]> {
    const prefix = listPrefix(options);
    const out: FileEntry[] = [];
    for (const [path, file] of this.files) {
      if (!this.matches(path, prefix, options)) continue;
      out.push(this.entry(path, file));
    }
    // Code-point order: deterministic across locales. UIs apply their own display sort.
    return out.sort((a, b) => comparePaths(a.path, b.path));
  }

  async listFolders(options: ListOptions = {}): Promise<string[]> {
    const prefix = listPrefix(options);
    return [...this.folders].filter((f) => this.matches(f, prefix, options)).sort(comparePaths);
  }

  async stat(path: string): Promise<FileEntry | null> {
    const p = toVaultPath(path);
    const file = this.files.get(p);
    return file ? this.entry(p, file) : null;
  }

  async read(path: string): Promise<FileContent | null> {
    const p = toVaultPath(path);
    const file = this.files.get(p);
    return file ? { ...this.entry(p, file), content: file.content } : null;
  }

  async write(path: string, content: string, options: WriteOptions = {}): Promise<WriteResult> {
    const p = toVaultPath(path);
    if (this.folders.has(p)) throw new StorageError(`Not a file: "${p}"`, p);
    const existing = this.files.get(p);
    this.checkPrecondition(p, existing, options);
    this.assertCanHoldFile(p);
    const file = this.store(p, content);
    this.emit({
      kind: existing ? "modified" : "created",
      path: p,
      version: file.version,
      self: true,
    });
    return {
      path: p,
      version: file.version,
      mtime: file.mtime,
      size: byteLength(file.content),
      created: !existing,
    };
  }

  async delete(path: string, options: WriteOptions = {}): Promise<void> {
    const p = toVaultPath(path);
    const existing = this.files.get(p);
    if (!existing) {
      if (typeof options.ifMatch === "string") throw new ConflictError(p, null);
      throw new NotFoundError(p);
    }
    this.checkPrecondition(p, existing, options);
    this.files.delete(p);
    this.emit({ kind: "deleted", path: p, self: true });
  }

  async rename(from: string, to: string): Promise<WriteResult> {
    const src = toVaultPath(from);
    const dst = toVaultPath(to);
    const file = this.files.get(src);
    if (!file) throw new NotFoundError(src);
    if (this.files.has(dst)) throw new ConflictError(dst, this.files.get(dst)!.version);
    if (this.folders.has(dst)) throw new ConflictError(dst, null);
    this.assertCanHoldFile(dst);
    this.files.delete(src);
    this.files.set(dst, file);
    for (const folder of ancestorFolders(dst)) this.folders.add(folder);
    this.emit({ kind: "deleted", path: src, self: true });
    this.emit({ kind: "created", path: dst, version: file.version, self: true });
    return {
      path: dst,
      version: file.version,
      mtime: file.mtime,
      size: byteLength(file.content),
      created: true,
    };
  }

  async createFolder(path: string): Promise<void> {
    const p = toVaultPath(path);
    if (this.folders.has(p)) return;
    if (this.files.has(p)) throw new StorageError(`A file already exists at "${p}"`, p);
    this.assertCanHoldFile(p);
    for (const folder of [...ancestorFolders(p), p]) this.folders.add(folder);
  }

  async deleteFolder(path: string): Promise<void> {
    const p = toVaultPath(path);
    if (this.files.has(p)) throw new StorageError(`"${p}" is not a folder`, p);
    if (!this.folders.has(p)) throw new NotFoundError(p);
    const inside = (candidate: string) => candidate === p || candidate.startsWith(`${p}/`);
    for (const folder of [...this.folders]) if (inside(folder)) this.folders.delete(folder);
    for (const file of [...this.files.keys()].filter(inside).sort(comparePaths)) {
      this.files.delete(file);
      this.emit({ kind: "deleted", path: file, self: true });
    }
  }

  watch(listener: (event: StorageEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    this.listeners.clear();
  }

  /** Test helper: mutate a file as if another application did it. */
  simulateExternalChange(path: string, content: string | null): void {
    const p = toVaultPath(path);
    const existed = this.files.has(p);
    if (content === null) {
      if (!existed) return;
      this.files.delete(p);
      this.emit({ kind: "deleted", path: p, self: false });
      return;
    }
    this.assertCanHoldFile(p);
    const file = this.store(p, content);
    this.emit({
      kind: existed ? "modified" : "created",
      path: p,
      version: file.version,
      self: false,
    });
  }

  private store(p: string, content: string): MemoryFile {
    const text = toStorableText(content);
    const file = { content: text, mtime: this.clock(), version: contentVersion(text) };
    this.files.set(p, file);
    for (const folder of ancestorFolders(p)) this.folders.add(folder);
    return file;
  }

  /** Like a disk: no file may sit where a folder for `p` would have to be. */
  private assertCanHoldFile(p: string): void {
    for (const folder of ancestorFolders(p)) {
      if (this.files.has(folder)) {
        throw new StorageError(`Cannot create the folder for "${p}": a file is in the way`, p);
      }
    }
  }

  private checkPrecondition(
    path: string,
    existing: MemoryFile | undefined,
    options: WriteOptions,
  ): void {
    if (options.ifMatch === undefined) return;
    if (options.ifMatch === null) {
      if (existing) throw new ConflictError(path, existing.version);
      return;
    }
    if (!existing || existing.version !== options.ifMatch) {
      throw new ConflictError(path, existing?.version ?? null);
    }
  }

  private matches(path: string, prefix: string, options: ListOptions): boolean {
    if (prefix && path !== prefix && !path.startsWith(`${prefix}/`)) return false;
    if (this.rules.isIgnored(path)) return false;
    return options.includeHidden || !isHiddenPath(path);
  }

  private entry(path: string, file: MemoryFile): FileEntry {
    return { path, size: byteLength(file.content), mtime: file.mtime, version: file.version };
  }

  private emit(event: StorageEvent): void {
    if (this.rules.isIgnored(event.path)) return;
    for (const listener of [...this.listeners]) listener(event);
  }
}

function toVaultPath(input: string): string {
  const p = normalizePath(input);
  if (p === "") throw new InvalidPathError(input, "is empty");
  return p;
}

function listPrefix(options: ListOptions): string {
  return options.prefix ? normalizePath(options.prefix) : "";
}

function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byteLength(content: string): number {
  return new TextEncoder().encode(content).byteLength;
}
