import {
  decodePersistedThread,
  encodePersistedThread,
  isPersistedArtifactPath,
  mergePersistedThreads,
  PERSISTED_BINARY_ARTIFACT_SUFFIX,
  PERSISTED_PATHS,
  PersistedFile,
  type PersistedThread,
  persistedThreadIdFromPath,
} from "@ddl/contract";
import {
  type ArtifactMeta,
  type CitedSource,
  createId,
  type Logger,
  type SurfaceKind,
  silentLogger,
  summarizeThread,
  type TaskAgentStatus,
  type Thread,
  type ThreadMessage,
  type ThreadSummary,
  type Unsubscribe,
} from "@ddl/core";
import type { StorageProvider } from "@ddl/storage";
import { artifactExtension, decodeBase64, encodeBase64, utf8Length } from "./artifacts";
import type { NewArtifact, ThreadStore, ThreadStoreEvent } from "./types";

export const THREADS_DIR = PERSISTED_PATHS.threads;
export const ARTIFACTS_DIR = PERSISTED_PATHS.artifacts;
/** Storage is text-only: binary artifact bodies are stored base64-encoded under this suffix. */
export const BINARY_ARTIFACT_SUFFIX = PERSISTED_BINARY_ARTIFACT_SUFFIX;

const LOAD_CONCURRENCY = 16;
const WRITE_RETRY_MS = 5_000;
const MAX_THREAD_SOURCES = 50;

export interface ThreadStoreOptions {
  storage: StorageProvider;
  now?: () => number;
  logger?: Logger;
  /** Debounce before a changed thread is written. Streaming deltas alone never schedule a write. */
  flushDelayMs?: number;
  /** Pending approvals per thread, included in `thread.upsert` summaries. */
  pendingApprovals?: (threadId: string) => number;
}

export function threadPath(threadId: string): string {
  return `${THREADS_DIR}/${threadId}.json`;
}

export function createThreadStore(options: ThreadStoreOptions): ThreadStore {
  return new SidecarThreadStore(options);
}

interface LoadedThread {
  path: string;
  thread: Thread;
  repaired: boolean;
}

/**
 * Threads persist one file each (`threads/<id>.json`, format in @ddl/contract). Loading follows the
 * shared rules: unreadable files are moved to `corrupt/`, files from a newer app are skipped and
 * never overwritten, and other copies of a thread (sync conflict copies) are merged into it.
 * Writes are conditional: a thread file changed by another device meanwhile is merged, not
 * clobbered. External changes are not watched live; they show up at the next write or restart.
 */
class SidecarThreadStore implements ThreadStore {
  private readonly storage: StorageProvider;
  private readonly now: () => number;
  private readonly logger: Logger;
  private readonly flushDelayMs: number;
  private readonly pendingApprovals: (threadId: string) => number;
  private readonly threads = new Map<string, Thread>();
  private readonly files = new Map<string, PersistedFile<PersistedThread>>();
  private readonly listeners = new Set<(event: ThreadStoreEvent) => void>();
  private readonly dirty = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly writes = new Map<string, Promise<void>>();

  constructor(options: ThreadStoreOptions) {
    this.storage = options.storage;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? silentLogger;
    this.flushDelayMs = options.flushDelayMs ?? 400;
    this.pendingApprovals = options.pendingApprovals ?? (() => 0);
  }

  async load(): Promise<void> {
    const entries = (await this.storage.list({ prefix: THREADS_DIR, includeHidden: true })).filter(
      (entry) =>
        entry.path.endsWith(".json") && !entry.path.slice(THREADS_DIR.length + 1).includes("/"),
    );
    const loaded: LoadedThread[] = [];
    let next = 0;
    const worker = async () => {
      while (next < entries.length) {
        const { path } = entries[next++]!;
        const file = this.fileAt(path, undefined);
        try {
          const result = await file.load();
          if (result.status === "loaded") {
            loaded.push({ path, thread: result.value, repaired: result.issues.length > 0 });
          } else if (result.status === "newer") {
            this.logger.warn("Skipping a thread saved by a newer version of the app", {
              path,
              version: result.version,
            });
          }
        } catch (error) {
          this.logger.warn("Failed to load thread", { path, error: errorText(error) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(LOAD_CONCURRENCY, entries.length) }, worker));
    this.adopt(loaded);
  }

  create(input: {
    id?: string;
    taskId: string | null;
    notePath: string | null;
    title: string;
  }): Thread {
    const at = this.now();
    const thread: Thread = {
      id: input.id ?? createId("thr"),
      taskId: input.taskId,
      notePath: input.notePath,
      title: input.title,
      status: "idle",
      createdAt: at,
      updatedAt: at,
      messages: [],
      artifacts: [],
      surfaces: [],
    };
    this.threads.set(thread.id, thread);
    this.fileAt(threadPath(thread.id), null);
    this.changed(thread, true);
    return snapshot(thread);
  }

  get(id: string): Thread | undefined {
    const thread = this.threads.get(id);
    return thread ? snapshot(thread) : undefined;
  }

  findByTask(taskId: string): Thread | undefined {
    let best: Thread | undefined;
    for (const thread of this.threads.values()) {
      if (thread.taskId !== taskId) continue;
      if (!best || thread.updatedAt > best.updatedAt) best = thread;
    }
    return best ? snapshot(best) : undefined;
  }

  list(filter: { notePath?: string; taskId?: string } = {}): ThreadSummary[] {
    const out: ThreadSummary[] = [];
    for (const thread of this.threads.values()) {
      if (filter.notePath !== undefined && thread.notePath !== filter.notePath) continue;
      if (filter.taskId !== undefined && thread.taskId !== filter.taskId) continue;
      out.push(this.summarize(thread));
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  upsertMessage(threadId: string, message: ThreadMessage): void {
    const thread = this.threads.get(threadId);
    if (!thread) {
      this.logger.warn("upsertMessage on unknown thread", { threadId });
      return;
    }
    const index = findMessageIndex(thread, message.id);
    if (index === -1) thread.messages.push(message);
    else thread.messages[index] = message;
    thread.updatedAt = this.now();
    this.emit({ type: "thread.message", threadId, message });
    // A message that is still streaming is persisted once it completes (or on flush).
    this.changed(thread, !(message.kind === "text" && message.streaming === true));
  }

  appendDelta(threadId: string, messageId: string, delta: string): void {
    if (!delta) return;
    const thread = this.threads.get(threadId);
    if (!thread) return;
    const index = findMessageIndex(thread, messageId);
    const current = index === -1 ? undefined : thread.messages[index];
    if (current?.kind !== "text") {
      this.logger.warn("appendDelta on a missing or non-text message", { threadId, messageId });
      return;
    }
    thread.messages[index] = { ...current, text: current.text + delta };
    this.dirty.add(threadId);
    this.emit({ type: "thread.delta", threadId, messageId, delta });
  }

  setStatus(threadId: string, status: TaskAgentStatus): void {
    const thread = this.threads.get(threadId);
    if (!thread || thread.status === status) return;
    thread.status = status;
    thread.updatedAt = this.now();
    this.changed(thread, true);
  }

  setTitle(threadId: string, title: string): void {
    const thread = this.threads.get(threadId);
    if (!thread || thread.title === title) return;
    thread.title = title;
    this.changed(thread, true);
  }

  trimMessages(threadId: string, keep: number): void {
    const thread = this.threads.get(threadId);
    if (!thread || thread.messages.length <= keep) return;
    thread.messages = thread.messages.slice(thread.messages.length - Math.max(0, keep));
    this.changed(thread, true);
  }

  addSurface(threadId: string, surface: SurfaceKind): void {
    const thread = this.threads.get(threadId);
    if (!thread || thread.surfaces.includes(surface)) return;
    thread.surfaces.push(surface);
    this.changed(thread, true);
  }

  addSources(threadId: string, sources: readonly CitedSource[]): void {
    const thread = this.threads.get(threadId);
    if (!thread || sources.length === 0) return;
    const byUrl = new Map((thread.sources ?? []).map((source) => [source.url, source]));
    let changed = false;
    for (const source of sources) {
      const known = byUrl.get(source.url);
      if (known && known.title === source.title && known.snippet === source.snippet) continue;
      byUrl.delete(source.url);
      byUrl.set(source.url, { ...known, ...source });
      changed = true;
    }
    if (!changed) return;
    thread.sources = [...byUrl.values()].slice(-MAX_THREAD_SOURCES);
    this.changed(thread, true);
  }

  async addArtifact(threadId: string, artifact: NewArtifact): Promise<ArtifactMeta> {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`Unknown thread: ${threadId}`);
    const id = createId("art");
    const binary = typeof artifact.content !== "string";
    const ext = artifactExtension(artifact.kind, artifact.mimeType, artifact.language);
    const path = `${ARTIFACTS_DIR}/${threadId}/${id}.${ext}${binary ? BINARY_ARTIFACT_SUFFIX : ""}`;
    const body =
      typeof artifact.content === "string" ? artifact.content : encodeBase64(artifact.content);
    const size =
      typeof artifact.content === "string"
        ? utf8Length(artifact.content)
        : artifact.content.byteLength;
    await this.storage.write(path, body);
    const meta: ArtifactMeta = {
      id,
      threadId,
      title: artifact.title,
      kind: artifact.kind,
      mimeType: artifact.mimeType,
      ...(artifact.language ? { language: artifact.language } : {}),
      path,
      size,
      createdAt: this.now(),
    };
    thread.artifacts.push(meta);
    thread.updatedAt = meta.createdAt;
    this.changed(thread, true);
    return meta;
  }

  async readArtifact(
    threadId: string,
    artifactId: string,
  ): Promise<{ meta: ArtifactMeta; body: Uint8Array } | null> {
    const meta = this.threads.get(threadId)?.artifacts.find((a) => a.id === artifactId);
    if (!meta || !isPersistedArtifactPath(meta.path)) return null;
    const file = await this.storage.read(meta.path);
    if (!file) return null;
    if (!meta.path.endsWith(BINARY_ARTIFACT_SUFFIX)) {
      return { meta, body: new TextEncoder().encode(file.content) };
    }
    const body = decodeBase64(file.content);
    if (!body) {
      this.logger.warn("Artifact body is not valid base64", { threadId, artifactId });
      return null;
    }
    return { meta, body };
  }

  async flush(): Promise<void> {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.all([...this.dirty].map((id) => this.persist(id)));
    await Promise.all([...this.writes.values()]);
  }

  on(listener: (event: ThreadStoreEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * One thread can come from several files: its own and copies (sync conflict copies). Its own
   * file wins, then the most recently updated copy; the others are merged in and the result is
   * written back to its own file.
   */
  private adopt(loaded: LoadedThread[]): void {
    const own = (entry: LoadedThread) => (entry.path === threadPath(entry.thread.id) ? 0 : 1);
    loaded.sort(
      (a, b) =>
        own(a) - own(b) ||
        b.thread.updatedAt - a.thread.updatedAt ||
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    );
    for (const entry of loaded) {
      const { id } = entry.thread;
      const current = this.threads.get(id);
      if (!current) {
        this.threads.set(id, entry.thread);
        if (entry.repaired || own(entry) === 1) this.dirty.add(id);
        continue;
      }
      const merged = mergePersistedThreads(current, entry.thread);
      if (encodePersistedThread(merged) !== encodePersistedThread(current)) {
        this.threads.set(id, merged);
        this.dirty.add(id);
      }
    }
    for (const id of this.dirty) this.schedule(id, this.flushDelayMs);
  }

  /** Another device changed this thread's file since we last read or wrote it. */
  private mergeExternal(threadId: string, theirs: Thread): void {
    const ours = this.threads.get(threadId);
    if (!ours) return;
    const merged = mergePersistedThreads(ours, theirs);
    const known = new Set(ours.messages.map((message) => message.id));
    this.threads.set(threadId, merged);
    for (const message of merged.messages) {
      if (!known.has(message.id)) this.emit({ type: "thread.message", threadId, message });
    }
    this.emit({ type: "thread.upsert", thread: this.summarize(merged) });
  }

  /** `known`: what the caller knows about the file (`null` = it does not exist). */
  private fileAt(path: string, known: string | null | undefined): PersistedFile<PersistedThread> {
    let file = this.files.get(path);
    if (!file) {
      const expectedId = persistedThreadIdFromPath(path) ?? undefined;
      file = new PersistedFile({
        storage: this.storage,
        path,
        decode: (text) => decodePersistedThread(text, expectedId),
        logger: this.logger,
        now: this.now,
        known,
      });
      this.files.set(path, file);
    }
    return file;
  }

  private summarize(thread: Thread): ThreadSummary {
    return summarizeThread(thread, this.pendingApprovals(thread.id));
  }

  private changed(thread: Thread, schedule: boolean): void {
    this.dirty.add(thread.id);
    if (schedule) this.schedule(thread.id, this.flushDelayMs);
    this.emit({ type: "thread.upsert", thread: this.summarize(thread) });
  }

  private schedule(threadId: string, delayMs: number): void {
    if (this.timers.has(threadId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(threadId);
      void this.persist(threadId);
    }, delayMs);
    this.timers.set(threadId, timer);
  }

  /** Writes are chained per thread so an older snapshot never lands after a newer one. */
  private persist(threadId: string): Promise<void> {
    const previous = this.writes.get(threadId) ?? Promise.resolve();
    const next = previous.then(() => this.writeNow(threadId));
    this.writes.set(threadId, next);
    void next.then(() => {
      if (this.writes.get(threadId) === next) this.writes.delete(threadId);
    });
    return next;
  }

  private async writeNow(threadId: string): Promise<void> {
    if (!this.threads.has(threadId) || !this.dirty.has(threadId)) return;
    this.dirty.delete(threadId);
    const file = this.fileAt(threadPath(threadId), null);
    try {
      await file.save(
        () => encodePersistedThread(this.threads.get(threadId)!),
        (theirs) => this.mergeExternal(threadId, theirs),
      );
    } catch (error) {
      this.dirty.add(threadId);
      this.logger.warn("Failed to persist thread; will retry", {
        threadId,
        error: errorText(error),
      });
      this.schedule(threadId, WRITE_RETRY_MS);
    }
  }

  private emit(event: ThreadStoreEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.logger.error("Thread store listener failed", { error: errorText(error) });
      }
    }
  }
}

function findMessageIndex(thread: Thread, messageId: string): number {
  // Updates almost always target one of the most recent messages.
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    if (thread.messages[i]!.id === messageId) return i;
  }
  return -1;
}

/** Copy with fresh arrays: message/artifact objects are never mutated in place by the store. */
function snapshot(thread: Thread): Thread {
  return {
    ...thread,
    messages: [...thread.messages],
    artifacts: [...thread.artifacts],
    surfaces: [...thread.surfaces],
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
