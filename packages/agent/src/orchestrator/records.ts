import {
  decodePersistedRecords,
  encodePersistedRecords,
  mergePersistedRecords,
  PERSISTED_PATHS,
  PersistedFile,
  type PersistedRecords,
} from "@ddl/contract";
import {
  Emitter,
  errorMessage,
  isActiveTaskStatus,
  type Logger,
  silentLogger,
  type TaskAgentRecord,
  type TaskAgentStatus,
  type TrackedTask,
  type Unsubscribe,
} from "@ddl/core";
import type { StorageProvider } from "@ddl/storage";
import type { SubagentSpec } from "./types";

export const RECORDS_PATH = PERSISTED_PATHS.records;

const DEFAULT_RETENTION_DAYS = 60;
const DAY_MS = 86_400_000;
const NOTE_EVENT_DELAY_MS = 30;
const SAVE_RETRY_MS = 5_000;

export type TaskRecordEvents = {
  "task.record": TaskAgentRecord;
  "task.records": { notePath: string; records: TaskAgentRecord[] };
};

export interface RecordPatch {
  status?: TaskAgentStatus;
  /** `null` clears the badge summary. */
  summary?: string | null;
  threadId?: string | null;
  text?: string;
  line?: number;
}

export interface TaskRecordsOptions {
  storage: StorageProvider;
  now?: () => number;
  logger?: Logger;
  flushDelayMs?: number;
  /** Inactive records untouched for longer than this are dropped at load (threads are kept). */
  retentionDays?: number;
}

/**
 * The agent badge state for every task (`TaskAgentRecord`) plus the last subagent spec per task
 * (so retries survive restarts), persisted to `.daily-do-list/state/records.json` (format in
 * @ddl/contract). Emits `task.record` per change and a debounced `task.records` snapshot when a
 * note's set of records or their positions change.
 */
export class TaskRecords {
  private readonly file: PersistedFile<PersistedRecords>;
  private readonly now: () => number;
  private readonly logger: Logger;
  private readonly flushDelayMs: number;
  private readonly retentionDays: number;
  private readonly records = new Map<string, TaskAgentRecord>();
  private readonly specs = new Map<string, SubagentSpec>();
  private readonly emitter = new Emitter<TaskRecordEvents>();
  private readonly dirtyNotes = new Set<string>();
  private notesTimer: ReturnType<typeof setTimeout> | undefined;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<void> = Promise.resolve();
  private dirty = false;

  constructor(options: TaskRecordsOptions) {
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? silentLogger;
    this.flushDelayMs = options.flushDelayMs ?? 300;
    this.retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
    this.file = new PersistedFile({
      storage: options.storage,
      path: RECORDS_PATH,
      decode: decodePersistedRecords,
      logger: this.logger,
      now: this.now,
    });
  }

  /**
   * A corrupt file is moved aside and records start empty; a file from a newer app is left alone
   * and never overwritten (records then live in memory only). Read errors are retried at save.
   */
  async load(): Promise<void> {
    let result: Awaited<ReturnType<PersistedFile<PersistedRecords>["load"]>>;
    try {
      result = await this.file.load();
    } catch (error) {
      this.logger.warn("Failed to read task records", { error: errorMessage(error) });
      return;
    }
    if (result.status !== "loaded") return;
    const cutoff = this.now() - this.retentionDays * DAY_MS;
    for (const record of result.value.records) {
      if (record.updatedAt < cutoff && !isActiveTaskStatus(record.status)) continue;
      if (!this.records.has(record.taskId)) this.records.set(record.taskId, record);
    }
    for (const [taskId, spec] of Object.entries(result.value.specs)) {
      if (this.records.has(taskId) && !this.specs.has(taskId)) this.specs.set(taskId, spec);
    }
    if (result.issues.length > 0) {
      this.dirty = true;
      this.scheduleSave();
    }
  }

  on<K extends keyof TaskRecordEvents>(
    event: K,
    listener: (payload: TaskRecordEvents[K]) => void,
  ): Unsubscribe {
    return this.emitter.on(event, listener);
  }

  get(taskId: string): TaskAgentRecord | undefined {
    const record = this.records.get(taskId);
    return record ? { ...record } : undefined;
  }

  list(notePath: string): TaskAgentRecord[] {
    const out: TaskAgentRecord[] = [];
    for (const record of this.records.values()) {
      if (record.notePath === notePath) out.push({ ...record });
    }
    return out.sort((a, b) => a.line - b.line);
  }

  all(): TaskAgentRecord[] {
    return [...this.records.values()].map((record) => ({ ...record }));
  }

  /** Returns the task's record, creating an `idle` one if it does not exist yet. */
  ensure(input: {
    taskId: string;
    notePath: string;
    date: string | null;
    text: string;
    line: number;
    anchor?: "line";
  }): TaskAgentRecord {
    const existing = this.records.get(input.taskId);
    if (existing) return { ...existing };
    const record: TaskAgentRecord = {
      taskId: input.taskId,
      notePath: input.notePath,
      date: input.date,
      text: input.text,
      line: input.line,
      status: "idle",
      threadId: null,
      updatedAt: this.now(),
      unread: 0,
      ...(input.anchor ? { anchor: input.anchor } : {}),
    };
    this.records.set(record.taskId, record);
    this.changed(record, true);
    return { ...record };
  }

  update(taskId: string, patch: RecordPatch): TaskAgentRecord | undefined {
    const record = this.records.get(taskId);
    if (!record) return undefined;
    let changed = false;
    if (patch.status !== undefined && patch.status !== record.status) {
      record.status = patch.status;
      changed = true;
    }
    if (patch.summary !== undefined) {
      if (patch.summary === null || patch.summary === "") {
        if (record.summary !== undefined) {
          delete record.summary;
          changed = true;
        }
      } else if (patch.summary !== record.summary) {
        record.summary = patch.summary;
        changed = true;
      }
    }
    if (patch.threadId !== undefined && patch.threadId !== record.threadId) {
      record.threadId = patch.threadId;
      changed = true;
    }
    if (patch.text !== undefined && patch.text !== record.text) {
      record.text = patch.text;
      changed = true;
    }
    if (patch.line !== undefined && patch.line !== record.line) {
      record.line = patch.line;
      this.dirtyNotes.add(record.notePath);
      changed = true;
    }
    if (changed) {
      record.updatedAt = this.now();
      this.changed(record, false);
    }
    return { ...record };
  }

  bumpUnread(taskId: string, by = 1): void {
    const record = this.records.get(taskId);
    if (!record) return;
    record.unread += by;
    record.updatedAt = this.now();
    this.changed(record, false);
  }

  markRead(taskId: string): void {
    const record = this.records.get(taskId);
    if (!record || record.unread === 0) return;
    record.unread = 0;
    this.changed(record, false);
  }

  /** Keeps text/line of existing records in sync with the latest parse (one snapshot event). */
  syncTasks(notePath: string, tasks: readonly TrackedTask[]): void {
    let changed = false;
    for (const task of tasks) {
      const record = this.records.get(task.id);
      if (!record || record.notePath !== notePath) continue;
      if (record.text === task.text && record.line === task.line) continue;
      record.text = task.text;
      record.line = task.line;
      changed = true;
    }
    if (!changed) return;
    this.dirty = true;
    this.scheduleSave();
    this.dirtyNotes.add(notePath);
    this.scheduleNoteEvents();
  }

  /** Records of the note's non-task lines (threads the orchestrator anchored to a line). */
  anchors(notePath: string): TaskAgentRecord[] {
    return this.list(notePath).filter((record) => record.anchor === "line");
  }

  /**
   * Moves the note's line anchors to where the latest parse found them (`resolveLineAnchors`) and
   * returns the ids of those no longer in the note.
   */
  syncAnchors(
    notePath: string,
    positions: ReadonlyMap<string, { line: number; text: string }>,
  ): string[] {
    const missing: string[] = [];
    let changed = false;
    for (const record of this.records.values()) {
      if (record.notePath !== notePath || record.anchor !== "line") continue;
      const at = positions.get(record.taskId);
      if (!at) {
        missing.push(record.taskId);
        continue;
      }
      if (record.line === at.line && record.text === at.text) continue;
      record.line = at.line;
      record.text = at.text;
      changed = true;
    }
    if (changed) {
      this.dirty = true;
      this.scheduleSave();
      this.dirtyNotes.add(notePath);
      this.scheduleNoteEvents();
    }
    return missing;
  }

  remove(taskId: string): void {
    const record = this.records.get(taskId);
    if (!record) return;
    this.records.delete(taskId);
    this.specs.delete(taskId);
    this.dirty = true;
    this.scheduleSave();
    this.dirtyNotes.add(record.notePath);
    this.scheduleNoteEvents();
  }

  getSpec(taskId: string): SubagentSpec | undefined {
    return this.specs.get(taskId);
  }

  setSpec(spec: SubagentSpec): void {
    this.specs.set(spec.taskId, spec);
    this.dirty = true;
    this.scheduleSave();
  }

  async flush(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    if (this.notesTimer) {
      clearTimeout(this.notesTimer);
      this.notesTimer = undefined;
      this.emitNoteEvents();
    }
    await this.save();
  }

  private changed(record: TaskAgentRecord, created: boolean): void {
    this.dirty = true;
    this.scheduleSave();
    this.emitter.emit("task.record", { ...record });
    if (created) this.dirtyNotes.add(record.notePath);
    if (this.dirtyNotes.size > 0) this.scheduleNoteEvents();
  }

  private scheduleNoteEvents(): void {
    if (this.notesTimer) return;
    this.notesTimer = setTimeout(() => {
      this.notesTimer = undefined;
      this.emitNoteEvents();
    }, NOTE_EVENT_DELAY_MS);
  }

  private emitNoteEvents(): void {
    const notes = [...this.dirtyNotes];
    this.dirtyNotes.clear();
    for (const notePath of notes) {
      this.emitter.emit("task.records", { notePath, records: this.list(notePath) });
    }
  }

  private scheduleSave(delayMs = this.flushDelayMs): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.save();
    }, delayMs);
  }

  /** Saves are serialized and never reject; a failed write is retried later. */
  private save(): Promise<void> {
    this.saving = this.saving.then(async () => {
      if (!this.dirty) return;
      this.dirty = false;
      try {
        await this.file.save(
          () => encodePersistedRecords(this.snapshot()),
          (theirs) => this.mergeExternal(theirs),
        );
      } catch (error) {
        this.dirty = true;
        this.logger.warn("Failed to persist task records; will retry", {
          error: errorMessage(error),
        });
        this.scheduleSave(SAVE_RETRY_MS);
      }
    });
    return this.saving;
  }

  private snapshot(): PersistedRecords {
    return { records: [...this.records.values()], specs: Object.fromEntries(this.specs) };
  }

  /** The file changed underneath us (another device, a restore): keep both sides' records. */
  private mergeExternal(theirs: PersistedRecords): void {
    const merged = mergePersistedRecords(this.snapshot(), theirs);
    for (const record of merged.records) {
      if (this.records.get(record.taskId) === record) continue;
      this.records.set(record.taskId, { ...record });
      this.dirtyNotes.add(record.notePath);
      this.emitter.emit("task.record", { ...record });
    }
    for (const [taskId, spec] of Object.entries(merged.specs)) {
      if (this.records.has(taskId) && !this.specs.has(taskId)) this.specs.set(taskId, spec);
    }
    if (this.dirtyNotes.size > 0) this.scheduleNoteEvents();
  }
}
