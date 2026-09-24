import {
  type ArtifactMeta,
  createId,
  type Logger,
  SIDECAR_DIR,
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

export const THREADS_DIR = `${SIDECAR_DIR}/threads`;
export const ARTIFACTS_DIR = `${SIDECAR_DIR}/artifacts`;
/** Storage is text-only: binary artifact bodies are stored base64-encoded under this suffix. */
export const BINARY_ARTIFACT_SUFFIX = ".b64";

const LOAD_CONCURRENCY = 16;
const WRITE_RETRY_MS = 5_000;

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

class SidecarThreadStore implements ThreadStore {
  private readonly storage: StorageProvider;
  private readonly now: () => number;
  private readonly logger: Logger;
  private readonly flushDelayMs: number;
  private readonly pendingApprovals: (threadId: string) => number;
  private readonly threads = new Map<string, Thread>();
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
      (entry) => entry.path.endsWith(".json"),
    );
    let next = 0;
    const worker = async () => {
      while (next < entries.length) {
        const entry = entries[next++]!;
        try {
          const file = await this.storage.read(entry.path);
          const thread = file ? parseThread(file.content) : null;
          if (!thread) {
            if (file) this.logger.warn("Skipping unreadable thread file", { path: entry.path });
            continue;
          }
          if (!this.threads.has(thread.id)) this.threads.set(thread.id, thread);
        } catch (error) {
          this.logger.warn("Failed to load thread", { path: entry.path, error: errorText(error) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(LOAD_CONCURRENCY, entries.length) }, worker));
  }

  create(input: { taskId: string | null; notePath: string | null; title: string }): Thread {
    const at = this.now();
    const thread: Thread = {
      id: createId("thr"),
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

  addSurface(threadId: string, surface: SurfaceKind): void {
    const thread = this.threads.get(threadId);
    if (!thread || thread.surfaces.includes(surface)) return;
    thread.surfaces.push(surface);
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
    if (!meta) return null;
    const file = await this.storage.read(meta.path);
    if (!file) return null;
    const body = meta.path.endsWith(BINARY_ARTIFACT_SUFFIX)
      ? decodeBase64(file.content)
      : new TextEncoder().encode(file.content);
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
    const thread = this.threads.get(threadId);
    if (!thread || !this.dirty.has(threadId)) return;
    this.dirty.delete(threadId);
    try {
      await this.storage.write(threadPath(threadId), `${JSON.stringify(thread)}\n`);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates the persisted shape; messages still marked as streaming were interrupted. */
export function parseThread(content: string): Thread | null {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return null;
  }
  if (
    !isRecord(raw) ||
    typeof raw.id !== "string" ||
    typeof raw.title !== "string" ||
    typeof raw.status !== "string" ||
    typeof raw.createdAt !== "number" ||
    typeof raw.updatedAt !== "number" ||
    !Array.isArray(raw.messages)
  ) {
    return null;
  }
  const messages = raw.messages
    .filter(
      (m): m is ThreadMessage =>
        isRecord(m) &&
        typeof m.id === "string" &&
        typeof m.kind === "string" &&
        typeof m.createdAt === "number",
    )
    .map((m) => (m.kind === "text" && m.streaming ? { ...m, streaming: false } : m));
  return {
    id: raw.id,
    taskId: typeof raw.taskId === "string" ? raw.taskId : null,
    notePath: typeof raw.notePath === "string" ? raw.notePath : null,
    title: raw.title,
    status: raw.status as TaskAgentStatus,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    messages,
    artifacts: Array.isArray(raw.artifacts)
      ? raw.artifacts.filter(
          (a): a is ArtifactMeta =>
            isRecord(a) && typeof a.id === "string" && typeof a.path === "string",
        )
      : [],
    surfaces: Array.isArray(raw.surfaces)
      ? raw.surfaces.filter((s): s is SurfaceKind => s === "browser" || s === "computer")
      : [],
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
