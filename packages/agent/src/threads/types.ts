/**
 * Threads are the conversation attached to one to-do item: agent comments, tool activity, approval
 * requests, artifacts and live surfaces. Persisted in the vault sidecar (`.daily-do-list/threads/`)
 * through the StorageProvider so they sync along with the notes.
 */
import type { PersistedJournalAllowedVia, PersistedJournalEvent } from "@ddl/contract";
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
import type { OpenToolCall } from "./journal/fold";

export type { OpenToolCall } from "./journal/fold";

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

/** A call the safety gate let through, as recorded right before it runs. */
export interface ToolCallStart {
  tool: string;
  /** What it does, in words ("Press Send in Slack"). */
  target: string;
  via?: PersistedJournalAllowedVia;
  /** The approval card a person decided, when there was one. */
  approvalId?: string;
  /**
   * False for calls that change nothing: recorded without waiting for the disk, since redoing
   * them is harmless. Absent counts as true.
   */
  effectful?: boolean;
}

export interface ToolCallEnd {
  outcome: "ok" | "error" | "blocked";
  /** What the model read (redacted, capped). */
  output?: string;
}

/**
 * The agent-state side of the thread journal (beyond what `ThreadStore` shows): the tool call
 * write-ahead log and the prompts that rebuild an agent session after a restart.
 */
export interface ThreadJournal {
  /** A tool call reached the safety gate (`input` display-safe). */
  recordToolRequested(
    threadId: string,
    call: { callId: string; tool: string; sessionId: string; input: unknown },
  ): void;
  /** The gate blocked the call. */
  recordToolBlocked(threadId: string, callId: string, reason: string): void;
  /**
   * Write-ahead: records that the call was allowed and is about to run, durably for an effectful
   * call (resolving once it's on disk). Resolves false when the thread keeps no journal (there is
   * nothing to resume it from); rejects when the record couldn't be written, and then the call
   * must not run.
   */
  recordToolStarting(threadId: string, callId: string, start: ToolCallStart): Promise<boolean>;
  recordToolFinished(threadId: string, callId: string, end: ToolCallEnd): void;
  /** A prompt sent to the thread's agent session. */
  recordPrompt(threadId: string, sessionId: string, text: string): void;
  /** Calls that started and never finished: after a restart, they may or may not have happened. */
  openToolCalls(threadId: string): OpenToolCall[];
  /** Marks open calls (all, or these) interrupted, never to be re-run automatically. */
  markInterrupted(threadId: string, callIds?: readonly string[]): OpenToolCall[];
  /** Calls marked interrupted since the thread's agent was last prompted. */
  interruptedCalls(threadId: string): OpenToolCall[];
  /** The thread's journal as stored, in canonical order (to rebuild an agent session). */
  readJournal(threadId: string): Promise<PersistedJournalEvent[]>;
}

export type JournaledThreadStore = ThreadStore & ThreadJournal;
