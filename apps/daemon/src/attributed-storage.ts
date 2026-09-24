import { normalizePath, type Unsubscribe } from "@ddl/core";
import type {
  FileContent,
  FileEntry,
  ListOptions,
  StorageCapabilities,
  StorageEvent,
  StorageProvider,
  StorageProviderKind,
  WriteOptions,
  WriteResult,
} from "@ddl/storage";
import type { WriteSource, WriteTracker } from "./write-tracker";

/**
 * View of the vault handed to an in-process writer (agent runtime, sync engine) that records its
 * writes in the WriteTracker, so change events are attributed correctly. Disposing it is a no-op:
 * the daemon owns the underlying provider.
 */
export class AttributedStorage implements StorageProvider {
  readonly kind: StorageProviderKind;
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: StorageCapabilities;
  private readonly inner: StorageProvider;
  private readonly writes: WriteTracker;
  private readonly source: WriteSource;

  constructor(inner: StorageProvider, writes: WriteTracker, source: WriteSource) {
    this.inner = inner;
    this.writes = writes;
    this.source = source;
    this.kind = inner.kind;
    this.id = inner.id;
    this.displayName = inner.displayName;
    this.capabilities = inner.capabilities;
  }

  list(options?: ListOptions): Promise<FileEntry[]> {
    return this.inner.list(options);
  }

  listFolders(options?: ListOptions): Promise<string[]> {
    return this.inner.listFolders(options);
  }

  stat(path: string): Promise<FileEntry | null> {
    return this.inner.stat(path);
  }

  read(path: string): Promise<FileContent | null> {
    return this.inner.read(path);
  }

  async write(path: string, content: string, options?: WriteOptions): Promise<WriteResult> {
    const result = await this.inner.write(path, content, options);
    this.writes.record(result.path, result.version, this.source);
    return result;
  }

  async delete(path: string, options?: WriteOptions): Promise<void> {
    await this.inner.delete(path, options);
    this.writes.record(normalizePath(path), undefined, this.source);
  }

  async rename(from: string, to: string): Promise<WriteResult> {
    const result = await this.inner.rename(from, to);
    this.writes.record(normalizePath(from), undefined, this.source);
    this.writes.record(result.path, result.version, this.source);
    return result;
  }

  createFolder(path: string): Promise<void> {
    return this.inner.createFolder(path);
  }

  async deleteFolder(path: string): Promise<void> {
    const folder = normalizePath(path);
    const files = await this.inner.list({ prefix: folder, includeHidden: true });
    // Recorded up front: providers emit each deletion as they go, and the hub may flush mid-way.
    for (const file of files) this.writes.record(file.path, undefined, this.source);
    await this.inner.deleteFolder(folder);
  }

  watch(listener: (event: StorageEvent) => void): Unsubscribe {
    return this.inner.watch(listener);
  }

  async dispose(): Promise<void> {}
}
