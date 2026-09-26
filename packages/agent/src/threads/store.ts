import {
  decodePersistedThreadJournal,
  isPersistedArtifactPath,
  PERSISTED_BINARY_ARTIFACT_SUFFIX,
  PERSISTED_FILE_ID_PATTERN,
  PERSISTED_PATHS,
  PersistedCitedSourceSchema,
  type PersistedJournalEvent,
  type PersistedJournalPayload,
  persistedThreadIdFromJournalPath,
  persistedThreadJournalPath,
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
  truncate,
  type Unsubscribe,
} from "@ddl/core";
import type { StorageProvider } from "@ddl/storage";
import { artifactExtension, decodeBase64, encodeBase64, utf8Length } from "./artifacts";
import {
  applyJournalPayload,
  emptyFold,
  findMessageIndex,
  foldJournal,
  type JournalFold,
  mergeSources,
  type OpenToolCall,
} from "./journal/fold";
import { forEachLimited, migrateThreadSnapshots } from "./journal/migrate";
import { type JournalExternalChange, JournalWriter } from "./journal/writer";
import type {
  JournaledThreadStore,
  NewArtifact,
  ThreadFilter,
  ThreadStoreEvent,
  ToolCallEnd,
  ToolCallStart,
} from "./types";

export const ARTIFACTS_DIR = PERSISTED_PATHS.artifacts;
export const THREAD_JOURNALS_DIR = PERSISTED_PATHS.threadJournals;
/** Storage is text-only: binary artifact bodies are stored base64-encoded under this suffix. */
export const BINARY_ARTIFACT_SUFFIX = PERSISTED_BINARY_ARTIFACT_SUFFIX;

const LOAD_CONCURRENCY = 16;
const WRITE_RETRY_MS = 5_000;
/** Journaled prompts and tool results are capped: they rebuild a session, they aren't an archive. */
const MAX_PROMPT_CHARS = 32_000;
const MAX_OUTPUT_CHARS = 8_000;
const MAX_TARGET_CHARS = 300;
const MAX_REASON_CHARS = 1_000;

export interface ThreadStoreOptions {
  storage: StorageProvider;
  now?: () => number;
  logger?: Logger;
  /** Debounce before a thread's new events are appended. Streaming deltas alone never schedule one. */
  flushDelayMs?: number;
  /** Pending approvals per thread, included in `thread.upsert` summaries. */
  pendingApprovals?: (threadId: string) => number;
  /** The agent lease's epoch, stamped on new journal events (0 until leases carry one). */
  epoch?: () => number;
}

export function threadJournalPath(threadId: string): string {
  return persistedThreadJournalPath(threadId);
}

export function createThreadStore(options: ThreadStoreOptions): JournaledThreadStore {
  return new SidecarThreadStore(options);
}

interface Entry {
  id: string;
  /** `fold.thread` is set for every entry in the map. */
  fold: JournalFold;
  journal: JournalWriter;
  /** Messages still streaming: kept in memory until final (or until the store is flushed). */
  streaming: Set<string>;
}

/**
 * Threads persist as an append-only journal each (`state/journal/threads/<id>.jsonl`, format in
 * @ddl/contract). Every change is an event, applied through the same fold that loading uses, so the
 * thread in memory is the thread a restart reads back.
 *
 * - Loading first moves the snapshots older apps wrote (`threads/<id>.json`) into their journals
 *   (`journal/migrate.ts`), then folds every journal. Lines a journal can't read are skipped and
 *   reported; a journal with a newer app's lines is left alone, and so is its thread.
 * - Events are appended in debounced batches, the tool call write-ahead record right away
 *   (`recordToolStarting`). Streaming text is journaled once final (or at a flush). Journals are
 *   never rewritten.
 * - Another writer's events (a sync merge, another device) are folded in at the next append; they
 *   aren't watched live.
 */
class SidecarThreadStore implements JournaledThreadStore {
  private readonly storage: StorageProvider;
  private readonly now: () => number;
  private readonly logger: Logger;
  private readonly flushDelayMs: number;
  private readonly pendingApprovals: (threadId: string) => number;
  private readonly epoch: () => number;
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<(event: ThreadStoreEvent) => void>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(options: ThreadStoreOptions) {
    this.storage = options.storage;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? silentLogger;
    this.flushDelayMs = options.flushDelayMs ?? 400;
    this.pendingApprovals = options.pendingApprovals ?? (() => 0);
    this.epoch = options.epoch ?? (() => 0);
  }

  async load(): Promise<void> {
    await migrateThreadSnapshots({
      storage: this.storage,
      logger: this.logger,
      now: this.now,
    }).catch((error: unknown) => {
      this.logger.warn("Failed to migrate thread snapshots", { error: errorText(error) });
    });
    const entries = await this.storage.list({ prefix: THREAD_JOURNALS_DIR, includeHidden: true });
    await forEachLimited(entries, LOAD_CONCURRENCY, async ({ path }) => {
      const id = persistedThreadIdFromJournalPath(path);
      if (!id) return;
      try {
        const file = await this.storage.read(path);
        if (file) this.adopt(id, path, file);
      } catch (error) {
        this.logger.warn("Failed to load thread journal", { path, error: errorText(error) });
      }
    });
  }

  create(input: {
    id?: string;
    taskId: string | null;
    notePath: string | null;
    title: string;
    routineId?: string;
  }): Thread {
    const id = input.id ?? createId("thr");
    const existing = this.entries.get(id);
    if (existing) {
      this.logger.warn("create on an existing thread", { threadId: id });
      return snapshot(existing.fold.thread!);
    }
    const at = this.now();
    const entry = this.newEntry(id);
    entry.journal.assumeMissing();
    this.entries.set(id, entry);
    this.commit(
      entry,
      {
        type: "thread.created",
        thread: {
          id,
          taskId: input.taskId,
          notePath: input.notePath,
          title: input.title,
          status: "idle",
          createdAt: at,
          ...(input.routineId ? { routineId: input.routineId } : {}),
        },
      },
      at,
    );
    this.changed(entry, true);
    return snapshot(entry.fold.thread!);
  }

  get(id: string): Thread | undefined {
    const thread = this.entries.get(id)?.fold.thread;
    return thread ? snapshot(thread) : undefined;
  }

  findByTask(taskId: string): Thread | undefined {
    let best: Thread | undefined;
    for (const { fold } of this.entries.values()) {
      const thread = fold.thread!;
      if (thread.taskId !== taskId) continue;
      if (!best || thread.updatedAt > best.updatedAt) best = thread;
    }
    return best ? snapshot(best) : undefined;
  }

  list(filter: ThreadFilter = {}): ThreadSummary[] {
    const out: ThreadSummary[] = [];
    for (const { fold } of this.entries.values()) {
      const thread = fold.thread!;
      if (filter.notePath !== undefined && thread.notePath !== filter.notePath) continue;
      if (filter.taskId !== undefined && thread.taskId !== filter.taskId) continue;
      if (filter.routineId !== undefined && thread.routineId !== filter.routineId) continue;
      out.push(this.summarize(thread));
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  upsertMessage(threadId: string, message: ThreadMessage): void {
    const entry = this.entries.get(threadId);
    if (!entry) {
      this.logger.warn("upsertMessage on unknown thread", { threadId });
      return;
    }
    const streaming = message.kind === "text" && message.streaming === true;
    const at = this.now();
    if (streaming) {
      entry.streaming.add(message.id);
      applyJournalPayload(entry.fold, { type: "message", message }, at, threadId);
    } else {
      entry.streaming.delete(message.id);
      this.commit(entry, { type: "message", message }, at);
    }
    this.emit({ type: "thread.message", threadId, message });
    // A message that is still streaming is persisted once it completes (or on flush).
    this.changed(entry, !streaming);
  }

  appendDelta(threadId: string, messageId: string, delta: string): void {
    if (!delta) return;
    const entry = this.entries.get(threadId);
    if (!entry) return;
    const thread = entry.fold.thread!;
    const index = findMessageIndex(thread, messageId);
    const current = index === -1 ? undefined : thread.messages[index];
    if (current?.kind !== "text") {
      this.logger.warn("appendDelta on a missing or non-text message", { threadId, messageId });
      return;
    }
    const next = { ...current, text: current.text + delta };
    if (current.streaming === true) thread.messages[index] = next;
    else this.commit(entry, { type: "message", message: next }, thread.updatedAt);
    this.emit({ type: "thread.delta", threadId, messageId, delta });
  }

  setStatus(threadId: string, status: TaskAgentStatus): void {
    const entry = this.entries.get(threadId);
    if (!entry || entry.fold.thread!.status === status) return;
    this.commit(entry, { type: "status", status });
    this.changed(entry, true);
  }

  setTitle(threadId: string, title: string): void {
    const entry = this.entries.get(threadId);
    if (!entry || entry.fold.thread!.title === title) return;
    this.commit(entry, { type: "title", title });
    this.changed(entry, true);
  }

  trimMessages(threadId: string, keep: number): void {
    const entry = this.entries.get(threadId);
    if (!entry || entry.fold.thread!.messages.length <= keep) return;
    this.commit(entry, { type: "trim", keep: Math.max(0, Math.floor(keep)) });
    this.changed(entry, true);
  }

  addSurface(threadId: string, surface: SurfaceKind): void {
    const entry = this.entries.get(threadId);
    if (!entry || entry.fold.thread!.surfaces.includes(surface)) return;
    this.commit(entry, { type: "surface", surface });
    this.changed(entry, true);
  }

  addSources(threadId: string, sources: readonly CitedSource[]): void {
    const entry = this.entries.get(threadId);
    if (!entry || sources.length === 0) return;
    // What the journal can't hold is dropped now rather than at the next restart.
    const valid = sources.filter((source) => PersistedCitedSourceSchema.safeParse(source).success);
    if (!mergeSources(entry.fold.thread!.sources, valid)) return;
    this.commit(entry, { type: "sources", sources: valid.map((source) => ({ ...source })) });
    this.changed(entry, true);
  }

  async addArtifact(threadId: string, artifact: NewArtifact): Promise<ArtifactMeta> {
    if (!this.entries.has(threadId)) throw new Error(`Unknown thread: ${threadId}`);
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
    const at = this.now();
    const meta: ArtifactMeta = {
      id,
      threadId,
      title: artifact.title,
      kind: artifact.kind,
      mimeType: artifact.mimeType,
      ...(artifact.language ? { language: artifact.language } : {}),
      path,
      size,
      createdAt: at,
    };
    const entry = this.entries.get(threadId);
    if (entry) {
      this.commit(entry, { type: "artifact", artifact: meta }, at);
      this.changed(entry, true);
    }
    return meta;
  }

  async readArtifact(
    threadId: string,
    artifactId: string,
  ): Promise<{ meta: ArtifactMeta; body: Uint8Array } | null> {
    const thread = this.entries.get(threadId)?.fold.thread;
    const meta = thread?.artifacts.find((artifact) => artifact.id === artifactId);
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
    for (const entry of this.entries.values()) this.journalStreaming(entry);
    // Every journal, pending or not: an append already under way finishes before this resolves.
    await Promise.all([...this.entries.keys()].map((id) => this.persist(id)));
  }

  on(listener: (event: ThreadStoreEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ── Journal (agent state) ─────────────────────────────────────────────────

  recordToolRequested(
    threadId: string,
    call: { callId: string; tool: string; sessionId: string; input: unknown },
  ): void {
    this.record(threadId, {
      type: "tool.requested",
      call: call.callId,
      tool: call.tool,
      session: call.sessionId,
      ...(call.input === undefined ? {} : { input: call.input }),
    });
  }

  recordToolBlocked(threadId: string, callId: string, reason: string): void {
    this.record(threadId, {
      type: "tool.decided",
      call: callId,
      allowed: false,
      reason: truncate(reason, MAX_REASON_CHARS),
    });
  }

  async recordToolStarting(
    threadId: string,
    callId: string,
    start: ToolCallStart,
  ): Promise<boolean> {
    const entry = this.entries.get(threadId);
    if (!entry || entry.journal.disabled !== null) return false;
    this.commit(entry, {
      type: "tool.decided",
      call: callId,
      allowed: true,
      ...(start.via ? { via: start.via } : {}),
      ...(start.approvalId ? { approvalId: start.approvalId } : {}),
    });
    const effectful = start.effectful !== false;
    this.commit(entry, {
      type: "tool.started",
      call: callId,
      tool: start.tool,
      target: truncate(start.target, MAX_TARGET_CHARS),
      ...(start.approvalId ? { approvalId: start.approvalId } : {}),
      ...(effectful ? {} : { effectful: false }),
    });
    if (effectful) await this.flushJournal(entry);
    else this.schedule(threadId, this.flushDelayMs);
    return true;
  }

  recordToolFinished(threadId: string, callId: string, end: ToolCallEnd): void {
    const entry = this.entries.get(threadId);
    const effectful = entry?.fold.open.get(callId)?.effectful === true;
    this.record(threadId, {
      type: "tool.finished",
      call: callId,
      outcome: end.outcome,
      ...(end.output === undefined ? {} : { output: truncate(end.output, MAX_OUTPUT_CHARS) }),
    });
    // Until this is on disk a restart would take the step for an uncertain one: write it now.
    if (entry && effectful) {
      this.flushJournal(entry).catch((error: unknown) => {
        this.logger.warn("Failed to journal a tool result; will retry", {
          threadId,
          error: errorText(error),
        });
      });
    }
  }

  recordPrompt(threadId: string, sessionId: string, text: string): void {
    this.record(threadId, {
      type: "run.prompted",
      session: sessionId,
      text: truncate(text, MAX_PROMPT_CHARS),
    });
    // A session is rebuilt from its prompts: don't leave one waiting for the next batch.
    const entry = this.entries.get(threadId);
    if (entry) {
      this.flushJournal(entry).catch((error: unknown) => {
        this.logger.warn("Failed to journal a prompt; will retry", {
          threadId,
          error: errorText(error),
        });
      });
    }
  }

  recordReply(threadId: string, sessionId: string, text: string): void {
    this.record(threadId, {
      type: "run.text",
      session: sessionId,
      text: truncate(text, MAX_PROMPT_CHARS),
    });
  }

  openToolCalls(threadId: string): OpenToolCall[] {
    return [...(this.entries.get(threadId)?.fold.open.values() ?? [])];
  }

  markInterrupted(threadId: string, callIds?: readonly string[]): OpenToolCall[] {
    const entry = this.entries.get(threadId);
    if (!entry) return [];
    const wanted = callIds ? new Set(callIds) : null;
    const calls = [...entry.fold.open.values()].filter(
      (call) => !wanted || wanted.has(call.callId),
    );
    for (const call of calls) this.commit(entry, { type: "tool.interrupted", call: call.callId });
    if (calls.length > 0) this.schedule(threadId, this.flushDelayMs);
    return calls;
  }

  interruptedCalls(threadId: string): OpenToolCall[] {
    return [...(this.entries.get(threadId)?.fold.interrupted ?? [])];
  }

  async readJournal(threadId: string): Promise<PersistedJournalEvent[]> {
    const entry = this.entries.get(threadId);
    if (!entry) return [];
    await this.flushJournal(entry);
    const file = await this.storage.read(entry.journal.path);
    return file ? decodePersistedThreadJournal(file.content, threadId).events : [];
  }

  // ── Loading ───────────────────────────────────────────────────────────────

  private adopt(id: string, path: string, file: { content: string; version: string }): void {
    const read = decodePersistedThreadJournal(file.content, id);
    if (read.newer !== null) {
      this.logger.warn("Skipping a thread whose journal a newer version of the app wrote", {
        path,
        version: read.newer,
      });
      return;
    }
    if (read.issues.length > 0) {
      this.logger.warn("Skipped unreadable journal lines", {
        path,
        skipped: read.issues.length,
        lines: read.issues.slice(0, 5).map((issue) => issue.path),
      });
    }
    const fold = foldJournal(read.events, id);
    if (!fold.thread) return;
    const entry = this.newEntry(id);
    entry.fold = fold;
    entry.journal.adopt(read, file.version);
    this.entries.set(id, entry);
  }

  // ── Changes ───────────────────────────────────────────────────────────────

  private newEntry(id: string): Entry {
    const journal = new JournalWriter({
      storage: this.storage,
      path: threadJournalPath(id),
      threadId: id,
      epoch: this.epoch,
      now: this.now,
      logger: this.logger,
    });
    if (!PERSISTED_FILE_ID_PATTERN.test(id)) journal.disable("the thread id can't name a file");
    return { id, fold: emptyFold(), journal, streaming: new Set() };
  }

  /** Records an event and applies it: the thread in memory is always the fold of its journal. */
  private commit(entry: Entry, payload: PersistedJournalPayload, at = this.now()): void {
    entry.journal.record(payload, at);
    applyJournalPayload(entry.fold, payload, at, entry.id);
  }

  /** An agent-state event: journaled, no visible change. */
  private record(threadId: string, payload: PersistedJournalPayload): void {
    const entry = this.entries.get(threadId);
    if (!entry) return;
    this.commit(entry, payload);
    this.schedule(threadId, this.flushDelayMs);
  }

  /** Journals messages still streaming as they are now (a flush: the process may be stopping). */
  private journalStreaming(entry: Entry): void {
    const thread = entry.fold.thread!;
    for (const messageId of entry.streaming) {
      const index = findMessageIndex(thread, messageId);
      const message = index === -1 ? undefined : thread.messages[index];
      if (message) this.commit(entry, { type: "message", message }, thread.updatedAt);
    }
  }

  /** Another writer appended to this thread's journal: fold everything again, in order. */
  private onJournalExternal(entry: Entry, change: JournalExternalChange): void {
    const before = entry.fold.thread!;
    const pending = entry.journal.pendingEvents();
    const fold = foldJournal([...change.read.events, ...pending], entry.id, {
      finishStreaming: false,
    });
    if (!fold.thread) return;
    for (const messageId of entry.streaming) {
      const index = findMessageIndex(before, messageId);
      if (index === -1) continue;
      applyJournalPayload(
        fold,
        { type: "message", message: before.messages[index]! },
        fold.thread.updatedAt,
        entry.id,
      );
    }
    entry.fold = fold;
    const known = new Set(before.messages.map((message) => message.id));
    for (const message of fold.thread.messages) {
      if (!known.has(message.id))
        this.emit({ type: "thread.message", threadId: entry.id, message });
    }
    this.emit({ type: "thread.upsert", thread: this.summarize(fold.thread) });
  }

  // ── Writing ───────────────────────────────────────────────────────────────

  private summarize(thread: Thread): ThreadSummary {
    return summarizeThread(thread, this.pendingApprovals(thread.id));
  }

  private changed(entry: Entry, schedule: boolean): void {
    if (schedule) this.schedule(entry.id, this.flushDelayMs);
    this.emit({ type: "thread.upsert", thread: this.summarize(entry.fold.thread!) });
  }

  private schedule(threadId: string, delayMs: number): void {
    if (this.timers.has(threadId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(threadId);
      void this.persist(threadId);
    }, delayMs);
    this.timers.set(threadId, timer);
  }

  private flushJournal(entry: Entry): Promise<void> {
    return entry.journal.flush({
      onExternal: (change) => this.onJournalExternal(entry, change),
      onMissing: () => ({ type: "thread.imported", thread: entry.fold.thread! }),
    });
  }

  private async persist(threadId: string): Promise<void> {
    const entry = this.entries.get(threadId);
    if (!entry) return;
    try {
      await this.flushJournal(entry);
    } catch (error) {
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
