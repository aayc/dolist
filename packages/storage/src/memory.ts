import {
  ancestorFolders,
  createId,
  hashString,
  isHiddenPath,
  normalizePath,
  type Unsubscribe,
} from "@ddl/core";
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
 * tests, e2e fixtures and as a sync target in tests. `simulateExternalChange` mimics edits made by
 * another app (emits `self: false` events).
 */
export class MemoryStorageProvider implements StorageProvider {
  readonly kind = "memory" as const;
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: StorageCapabilities = { watch: true, atomicWrites: true, folders: true };

  private readonly files = new Map<string, MemoryFile>();
  private readonly folders = new Set<string>();
  private readonly listeners = new Set<(event: StorageEvent) => void>();
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
      const p = normalizePath(path);
      this.files.set(p, { content, mtime: this.clock(), version: contentVersion(content) });
    }
  }

  async list(options: ListOptions = {}): Promise<FileEntry[]> {
    const out: FileEntry[] = [];
    for (const [path, file] of this.files) {
      if (!this.matches(path, options)) continue;
      out.push(this.entry(path, file));
    }
    // Code-point order: deterministic across locales. UIs apply their own display sort.
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  async listFolders(options: ListOptions = {}): Promise<string[]> {
    const all = new Set<string>();
    for (const folder of this.folders) {
      all.add(folder);
      for (const ancestor of ancestorFolders(folder)) all.add(ancestor);
    }
    for (const path of this.files.keys()) {
      for (const ancestor of ancestorFolders(path)) all.add(ancestor);
    }
    return [...all].filter((f) => this.matches(f, options)).sort();
  }

  async stat(path: string): Promise<FileEntry | null> {
    const p = normalizePath(path);
    const file = this.files.get(p);
    return file ? this.entry(p, file) : null;
  }

  async read(path: string): Promise<FileContent | null> {
    const p = normalizePath(path);
    const file = this.files.get(p);
    return file ? { ...this.entry(p, file), content: file.content } : null;
  }

  async write(path: string, content: string, options: WriteOptions = {}): Promise<WriteResult> {
    const p = normalizePath(path);
    const existing = this.files.get(p);
    this.checkPrecondition(p, existing, options);
    const file = { content, mtime: this.clock(), version: contentVersion(content) };
    this.files.set(p, file);
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
      size: byteLength(content),
      created: !existing,
    };
  }

  async delete(path: string, options: WriteOptions = {}): Promise<void> {
    const p = normalizePath(path);
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
    const src = normalizePath(from);
    const dst = normalizePath(to);
    const file = this.files.get(src);
    if (!file) throw new NotFoundError(src);
    if (this.files.has(dst)) throw new ConflictError(dst, this.files.get(dst)!.version);
    this.files.delete(src);
    this.files.set(dst, file);
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
    this.folders.add(normalizePath(path));
  }

  async deleteFolder(path: string): Promise<void> {
    const p = normalizePath(path);
    if (p === "") throw new StorageError("Refusing to delete the vault root");
    const inside = (candidate: string) => candidate === p || candidate.startsWith(`${p}/`);
    const files = [...this.files.keys()].filter(inside);
    const folders = [...this.folders].filter(inside);
    if (files.length === 0 && folders.length === 0) throw new NotFoundError(p);
    for (const folder of folders) this.folders.delete(folder);
    for (const file of files) {
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
    const p = normalizePath(path);
    const existed = this.files.has(p);
    if (content === null) {
      if (!existed) return;
      this.files.delete(p);
      this.emit({ kind: "deleted", path: p, self: false });
      return;
    }
    const file = { content, mtime: this.clock(), version: contentVersion(content) };
    this.files.set(p, file);
    this.emit({
      kind: existed ? "modified" : "created",
      path: p,
      version: file.version,
      self: false,
    });
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

  private matches(path: string, options: ListOptions): boolean {
    if (options.prefix) {
      const prefix = normalizePath(options.prefix);
      if (prefix && path !== prefix && !path.startsWith(`${prefix}/`)) return false;
    }
    return options.includeHidden || !isHiddenPath(path);
  }

  private entry(path: string, file: MemoryFile): FileEntry {
    return { path, size: byteLength(file.content), mtime: file.mtime, version: file.version };
  }

  private emit(event: StorageEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

function byteLength(content: string): number {
  return new TextEncoder().encode(content).byteLength;
}
