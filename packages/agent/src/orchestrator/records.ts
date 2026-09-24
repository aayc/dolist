import {
  Emitter,
  isActiveTaskStatus,
  type Logger,
  SIDECAR_DIR,
  silentLogger,
  type TaskAgentRecord,
  type TaskAgentStatus,
  type TrackedTask,
  type Unsubscribe,
} from "@ddl/core";
import type { StorageProvider } from "@ddl/storage";
import type { Capability } from "../execution/types";
import type { SubagentSpec } from "./types";

export const RECORDS_PATH = `${SIDECAR_DIR}/state/records.json`;

const DEFAULT_RETENTION_DAYS = 60;
const DAY_MS = 86_400_000;
const NOTE_EVENT_DELAY_MS = 30;
const SAVE_RETRY_MS = 5_000;
const CAPABILITIES: readonly Capability[] = [
  "web",
  "browser",
  "computer",
  "shell",
  "files",
  "connectors",
];

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

interface PersistedRecords {
  version: 1;
  records: TaskAgentRecord[];
  /** Last subagent spec per task, so retries survive restarts. */
  specs: Record<string, SubagentSpec>;
}

/**
 * The agent badge state for every task (`TaskAgentRecord`), persisted to
 * `.daily-do-list/state/records.json`. Emits `task.record` per change and a debounced
 * `task.records` snapshot when a note's set of records or their positions change.
 */
export class TaskRecords {
  private readonly storage: StorageProvider;
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
    this.storage = options.storage;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? silentLogger;
    this.flushDelayMs = options.flushDelayMs ?? 300;
    this.retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  }

  async load(): Promise<void> {
    let file: Awaited<ReturnType<StorageProvider["read"]>>;
    try {
      file = await this.storage.read(RECORDS_PATH);
    } catch (error) {
      this.logger.warn("Failed to read task records", { error: errorText(error) });
      return;
    }
    const persisted = file ? parsePersisted(file.content) : null;
    if (!persisted) return;
    const cutoff = this.now() - this.retentionDays * DAY_MS;
    for (const record of persisted.records) {
      if (record.updatedAt < cutoff && !isActiveTaskStatus(record.status)) continue;
      if (!this.records.has(record.taskId)) this.records.set(record.taskId, record);
    }
    for (const [taskId, spec] of Object.entries(persisted.specs)) {
      if (this.records.has(taskId) && !this.specs.has(taskId)) this.specs.set(taskId, spec);
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
        const persisted: PersistedRecords = {
          version: 1,
          records: [...this.records.values()],
          specs: Object.fromEntries(this.specs),
        };
        await this.storage.write(RECORDS_PATH, `${JSON.stringify(persisted)}\n`);
      } catch (error) {
        this.dirty = true;
        this.logger.warn("Failed to persist task records; will retry", {
          error: errorText(error),
        });
        this.scheduleSave(SAVE_RETRY_MS);
      }
    });
    return this.saving;
  }
}

function isRecordShape(value: unknown): value is TaskAgentRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.taskId === "string" &&
    typeof r.notePath === "string" &&
    typeof r.text === "string" &&
    typeof r.line === "number" &&
    typeof r.status === "string" &&
    typeof r.updatedAt === "number"
  );
}

function isSpecShape(value: unknown): value is SubagentSpec {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.taskId === "string" &&
    typeof s.goal === "string" &&
    Array.isArray(s.capabilities) &&
    s.capabilities.every((c) => CAPABILITIES.includes(c as Capability))
  );
}

function parsePersisted(content: string): PersistedRecords | null {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.records)) return null;
  const records = r.records.filter(isRecordShape).map((record) => ({
    ...record,
    date: typeof record.date === "string" ? record.date : null,
    threadId: typeof record.threadId === "string" ? record.threadId : null,
    unread: typeof record.unread === "number" ? record.unread : 0,
  }));
  const specs: Record<string, SubagentSpec> = {};
  if (typeof r.specs === "object" && r.specs !== null) {
    for (const [taskId, spec] of Object.entries(r.specs as Record<string, unknown>)) {
      if (isSpecShape(spec)) specs[taskId] = spec;
    }
  }
  return { version: 1, records, specs };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
