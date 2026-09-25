import {
  decodePersistedThreadJournal,
  encodePersistedJournalEvent,
  PERSISTED_THREAD_JOURNAL_VERSION,
  type PersistedJournalEvent,
  type PersistedJournalPayload,
  type PersistedJournalRead,
  PersistedWriteConflictError,
} from "@ddl/contract";
import { createId, type Logger } from "@ddl/core";
import { appendToFile, type StorageProvider } from "@ddl/storage";

const MAX_APPEND_ATTEMPTS = 4;

export interface JournalWriterOptions {
  storage: StorageProvider;
  path: string;
  threadId: string;
  /** The agent lease's epoch (0 until leases carry one). */
  epoch: () => number;
  now: () => number;
  logger: Logger;
}

/** What `flush` found when the journal changed underneath (another device, a sync merge). */
export interface JournalExternalChange {
  /** Events on disk this writer didn't know, in canonical order. */
  added: PersistedJournalEvent[];
  /** The whole journal as read (known events included). */
  read: PersistedJournalRead;
}

/**
 * Appends one thread's events to its journal file. Events are recorded in memory (with their id and
 * `(epoch, seq)`) and appended in batches by `flush`, which appends conditionally on the version it
 * last saw: when the file changed underneath, it re-reads it, reports the events it didn't know,
 * renumbers what it hasn't written yet after them, and appends again. It never rewrites the file.
 */
export class JournalWriter {
  readonly path: string;
  private readonly options: JournalWriterOptions;
  /** Version of the file as last read or written: `null` = absent, `undefined` = unknown. */
  private known: string | null | undefined = undefined;
  private endsWithNewline = true;
  private maxSeq = 0;
  private readonly ids = new Set<string>();
  private pending: PersistedJournalEvent[] = [];
  private queue: Promise<void> = Promise.resolve();
  private disabledReason: string | null = null;

  constructor(options: JournalWriterOptions) {
    this.options = options;
    this.path = options.path;
  }

  /** Why nothing is written to this journal (null: it is written). */
  get disabled(): string | null {
    return this.disabledReason;
  }

  get hasPending(): boolean {
    return this.pending.length > 0;
  }

  /** Recorded events not written yet, in order. */
  pendingEvents(): PersistedJournalEvent[] {
    return [...this.pending];
  }

  /** Starts from a journal read at load (`version` of the file that was read). */
  adopt(read: PersistedJournalRead, version: string): void {
    this.known = version;
    this.endsWithNewline = read.endsWithNewline;
    this.maxSeq = Math.max(this.maxSeq, read.maxSeq);
    for (const event of read.events) this.ids.add(event.id);
  }

  /** The file is known not to exist (a thread created in this process). */
  assumeMissing(): void {
    if (this.known === undefined && this.ids.size === 0) this.known = null;
  }

  /** Stops writing this journal for the rest of the run. */
  disable(reason: string): void {
    if (this.disabledReason !== null) return;
    this.disabledReason = reason;
    this.pending = [];
    this.options.logger.warn("Not writing a thread journal this run", { path: this.path, reason });
  }

  /** Records an event (appended at the next flush) and returns it. Nothing is queued when disabled. */
  record(payload: PersistedJournalPayload, at: number): PersistedJournalEvent {
    const event = {
      v: PERSISTED_THREAD_JOURNAL_VERSION,
      id: createId("evt"),
      epoch: this.options.epoch(),
      seq: ++this.maxSeq,
      at,
      ...payload,
    } as PersistedJournalEvent;
    if (this.disabledReason === null) this.pending.push(event);
    return event;
  }

  /**
   * Appends everything recorded so far. `onExternal` sees events another writer added meanwhile;
   * `onMissing` supplies a `thread.imported` payload when the file vanished after this writer had
   * written to it, so a recreated journal still holds the whole thread. Storage errors reject (the
   * events stay queued for the next flush).
   */
  flush(hooks: {
    onExternal: (change: JournalExternalChange) => void;
    onMissing: () => PersistedJournalPayload;
  }): Promise<void> {
    const run = this.queue.then(() => this.append(hooks));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async append(hooks: {
    onExternal: (change: JournalExternalChange) => void;
    onMissing: () => PersistedJournalPayload;
  }): Promise<void> {
    for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt++) {
      if (this.disabledReason !== null || this.pending.length === 0) return;
      if (this.known === undefined) {
        await this.reread(hooks);
        continue;
      }
      const batch = this.pending.slice();
      const text =
        (this.endsWithNewline ? "" : "\n") + batch.map(encodePersistedJournalEvent).join("");
      try {
        const written = await appendToFile(this.options.storage, this.path, text, {
          ifMatch: this.known,
        });
        this.known = written.version;
        this.endsWithNewline = true;
        for (const event of batch) this.ids.add(event.id);
        this.pending.splice(0, batch.length);
        return;
      } catch (error) {
        if (!(error instanceof Error && error.name === "ConflictError")) throw error;
        this.known = undefined;
      }
    }
    throw new PersistedWriteConflictError(this.path);
  }

  private async reread(hooks: {
    onExternal: (change: JournalExternalChange) => void;
    onMissing: () => PersistedJournalPayload;
  }): Promise<void> {
    const file = await this.options.storage.read(this.path);
    if (!file) {
      const hadWritten = this.ids.size > 0;
      this.known = null;
      this.endsWithNewline = true;
      if (hadWritten) {
        this.options.logger.warn("A thread journal disappeared; starting it again from memory", {
          path: this.path,
        });
        this.ids.clear();
        const restart = this.recordFirst(hooks.onMissing());
        this.pending = [restart, ...this.pending];
      }
      return;
    }
    const read = decodePersistedThreadJournal(file.content, this.options.threadId);
    if (read.newer !== null) {
      this.disable(`it holds events from a newer version of the app (v${read.newer})`);
      return;
    }
    const pendingIds = new Set(this.pending.map((event) => event.id));
    const added = read.events.filter(
      (event) => !this.ids.has(event.id) && !pendingIds.has(event.id),
    );
    for (const event of read.events) this.ids.add(event.id);
    this.known = file.version;
    this.endsWithNewline = read.endsWithNewline;
    this.maxSeq = Math.max(this.maxSeq, read.maxSeq);
    // What isn't written yet goes after everything on disk, in the order it was recorded.
    this.pending = this.pending
      .filter((event) => !this.ids.has(event.id))
      .map((event) => ({ ...event, seq: ++this.maxSeq }));
    if (added.length > 0) hooks.onExternal({ added, read });
  }

  private recordFirst(payload: PersistedJournalPayload): PersistedJournalEvent {
    this.maxSeq = 0;
    const event = {
      v: PERSISTED_THREAD_JOURNAL_VERSION,
      id: createId("evt"),
      epoch: this.options.epoch(),
      seq: ++this.maxSeq,
      at: this.options.now(),
      ...payload,
    } as PersistedJournalEvent;
    this.pending = this.pending.map((pending) => ({ ...pending, seq: ++this.maxSeq }));
    return event;
  }
}
