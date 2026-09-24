/**
 * Minimal `PersistedStorage` with the StorageProvider semantics PersistedFile relies on
 * (content versions, `ifMatch`, `ConflictError`/`NotFoundError` by name) plus failure injection.
 * The owner modules' tests use the real MemoryStorageProvider instead.
 */
import type { PersistedStorage } from "../../src/persisted";

class NamedError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

export class FakeStorage implements PersistedStorage {
  readonly files = new Map<string, { content: string; version: string }>();
  failRename: Error | null = null;
  failWrite: ((path: string) => Error | null) | null = null;
  /** Runs before each write lands, e.g. to simulate a concurrent external change. */
  beforeWrite: ((path: string) => void) | null = null;
  writes: string[] = [];
  private counter = 0;

  constructor(initial: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(initial)) this.put(path, content);
  }

  /** Mutates a file as another device would (new version, no precondition). */
  put(path: string, content: string): string {
    const version = `v${++this.counter}`;
    this.files.set(path, { content, version });
    return version;
  }

  async read(path: string): Promise<{ content: string; version: string } | null> {
    const file = this.files.get(path);
    return file ? { ...file } : null;
  }

  async write(
    path: string,
    content: string,
    options: { ifMatch?: string | null } = {},
  ): Promise<{ version: string }> {
    const failure = this.failWrite?.(path);
    if (failure) throw failure;
    this.beforeWrite?.(path);
    const existing = this.files.get(path);
    if (options.ifMatch !== undefined) {
      const current = existing?.version ?? null;
      if (current !== options.ifMatch) throw new NamedError("ConflictError", `conflict: ${path}`);
    }
    this.writes.push(path);
    return { version: this.put(path, content) };
  }

  async rename(from: string, to: string): Promise<unknown> {
    if (this.failRename) throw this.failRename;
    const file = this.files.get(from);
    if (!file) throw new NamedError("NotFoundError", `missing: ${from}`);
    if (this.files.has(to)) throw new NamedError("ConflictError", `exists: ${to}`);
    this.files.delete(from);
    this.files.set(to, file);
    return { path: to };
  }

  content(path: string): string | undefined {
    return this.files.get(path)?.content;
  }

  paths(): string[] {
    return [...this.files.keys()].sort();
  }
}
