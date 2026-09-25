/**
 * Threads are the conversation attached to one to-do item: agent comments, tool activity, approval
 * requests, artifacts and live surfaces. Persisted in the vault sidecar (`.daily-do-list/threads/`)
 * through the StorageProvider so they sync along with the notes.
 */
import type {
  ArtifactKind,
  ArtifactMeta,
  CitedSource,
  SurfaceKind,
  TaskAgentStatus,
  Thread,
  ThreadMessage,
  ThreadSummary,
  Unsubscribe,
} from "@ddl/core";

export interface NewArtifact {
  title: string;
  kind: ArtifactKind;
  mimeType: string;
  language?: string;
  /** UTF-8 text, or raw bytes for images/files. */
  content: string | Uint8Array;
}

export type ThreadStoreEvent =
  | { type: "thread.upsert"; thread: ThreadSummary }
  | { type: "thread.message"; threadId: string; message: ThreadMessage }
  | { type: "thread.delta"; threadId: string; messageId: string; delta: string };

export interface ThreadFilter {
  notePath?: string;
  taskId?: string;
  routineId?: string;
}

export interface ThreadStore {
  /** Loads persisted threads from storage. Call once at startup. */
  load(): Promise<void>;
  /** A new thread; `id` gives it a well-known id instead of a random one. */
  create(input: {
    id?: string;
    taskId: string | null;
    notePath: string | null;
    title: string;
    /** A routine's run. */
    routineId?: string;
  }): Thread;
  get(id: string): Thread | undefined;
  findByTask(taskId: string): Thread | undefined;
  list(filter?: ThreadFilter): ThreadSummary[];
  /** Appends (or replaces, when a message with the same id exists) a message. */
  upsertMessage(threadId: string, message: ThreadMessage): void;
  /** Appends streamed text to a `text` message and emits `thread.delta`. */
  appendDelta(threadId: string, messageId: string, delta: string): void;
  setStatus(threadId: string, status: TaskAgentStatus): void;
  setTitle(threadId: string, title: string): void;
  /** Drops the oldest messages beyond the newest `keep`. */
  trimMessages(threadId: string, keep: number): void;
  addSurface(threadId: string, surface: SurfaceKind): void;
  /** Remembers web pages the thread cites (deduplicated by URL, newest kept, capped). */
  addSources(threadId: string, sources: readonly CitedSource[]): void;
  addArtifact(threadId: string, artifact: NewArtifact): Promise<ArtifactMeta>;
  readArtifact(
    threadId: string,
    artifactId: string,
  ): Promise<{ meta: ArtifactMeta; body: Uint8Array } | null>;
  /** Persists pending changes (writes are debounced internally). */
  flush(): Promise<void>;
  on(listener: (event: ThreadStoreEvent) => void): Unsubscribe;
}
