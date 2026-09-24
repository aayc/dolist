import {
  type AppSettings,
  Emitter,
  hashString,
  isBlankTaskText,
  isClosedStatus,
  isWithinWindow,
  type LocalDate,
  type Logger,
  normalizePath,
  type ParsedTask,
  parseDailyNotePath,
  parseTasks,
  SIDECAR_DIR,
  silentLogger,
  type TaskChangeKind,
  type TrackedTask,
  today,
  toISODate,
  trackTasks,
  type Unsubscribe,
} from "@ddl/core";
import type { StorageEvent, StorageProvider } from "@ddl/storage";
import type { TaskEvent } from "./types";

export const TASK_STATE_DIR = `${SIDECAR_DIR}/state/tasks`;

const DEFAULT_ACTIVITY_WINDOW_MS = 1_500;
const DEFAULT_QUICK_SETTLE_MS = 700;
const DEFAULT_PERSIST_DELAY_MS = 300;

export interface TaskWatcherOptions {
  storage: StorageProvider;
  settings: AppSettings;
  now?: () => number;
  logger?: Logger;
  /** Editor activity on a task's line within this window postpones its settle. */
  activityWindowMs?: number;
  /**
   * Settle delay used when the editor reports the cursor on another line than the task (the user
   * moved on, e.g. pressed Enter). Capped by `settings.agent.settleMs`; set it to `Infinity` to
   * always wait the full settle delay.
   */
  quickSettleMs?: number;
  persistDelayMs?: number;
  idFactory?: () => string;
}

export type TaskWatcherEvents = {
  /** A settled change to one task. */
  task: TaskEvent;
  /** Every re-parse of a watched note (unsettled): keeps lines/text of records current. */
  tasks: { notePath: string; date: string | null; tasks: readonly TrackedTask[] };
};

/** Read access to the tracked tasks, shared with the orchestrator. */
export interface TaskLookup {
  findTask(
    taskId: string,
  ): { task: TrackedTask; notePath: string; date: string | null } | undefined;
  getTasks(notePath: string): readonly TrackedTask[];
}

interface SettledSnapshot {
  /** The task as of the last settled event: the baseline for the next one. */
  task: TrackedTask;
  /** The orchestrator knows about this task (it had text when it settled). */
  announced: boolean;
}

interface PersistedNoteState {
  version: 1;
  notePath: string;
  contentVersion: string | null;
  tasks: TrackedTask[];
  settled: Record<string, SettledSnapshot>;
}

interface NoteState {
  notePath: string;
  date: string | null;
  contentVersion: string | null;
  tasks: TrackedTask[];
  /** Removed tasks whose removal has not settled yet; a cut/paste revives them with their id. */
  ghosts: TrackedTask[];
  settled: Map<string, SettledSnapshot>;
  loaded: boolean;
  /** Tracker state exists (persisted or established this run); otherwise the next read is a first sight. */
  tracked: boolean;
  processing: Promise<void> | null;
  rerun: "event" | "scan" | null;
  saveTimer: ReturnType<typeof setTimeout> | undefined;
}

interface PendingSettle {
  taskId: string;
  notePath: string;
  lastChangeAt: number;
  immediate: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Watches the daily notes inside the configured window, tracks task identity across edits and
 * emits settled `TaskEvent`s once a task has been quiet for `settings.agent.settleMs`.
 *
 * All storage events count, including the provider's own (`self`) writes: the web editor writes
 * through the same provider as the daemon.
 */
export class TaskWatcher implements TaskLookup {
  private readonly storage: StorageProvider;
  private readonly now: () => number;
  private readonly logger: Logger;
  private readonly activityWindowMs: number;
  private readonly quickSettleMs: number;
  private readonly persistDelayMs: number;
  private readonly idFactory: (() => string) | undefined;
  private readonly emitter = new Emitter<TaskWatcherEvents>();
  private readonly notes = new Map<string, NoteState>();
  private readonly pending = new Map<string, PendingSettle>();
  private readonly activity = new Map<string, { line: number; at: number }>();
  private settings: AppSettings;
  private watched = new Set<string>();
  private todayIso = "";
  private running = false;
  private unsubscribe: Unsubscribe | undefined;
  private rolloverTimer: ReturnType<typeof setTimeout> | undefined;
  private scanning: Promise<void> | null = null;

  constructor(options: TaskWatcherOptions) {
    this.storage = options.storage;
    this.settings = options.settings;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? silentLogger;
    this.activityWindowMs = options.activityWindowMs ?? DEFAULT_ACTIVITY_WINDOW_MS;
    this.quickSettleMs = options.quickSettleMs ?? DEFAULT_QUICK_SETTLE_MS;
    this.persistDelayMs = options.persistDelayMs ?? DEFAULT_PERSIST_DELAY_MS;
    this.idFactory = options.idFactory;
  }

  get isRunning(): boolean {
    return this.running;
  }

  on<K extends keyof TaskWatcherEvents>(
    event: K,
    listener: (payload: TaskWatcherEvents[K]) => void,
  ): Unsubscribe {
    return this.emitter.on(event, listener);
  }

  /** Subscribes to storage, then scans the watched notes (resolves when the scan is done). */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.unsubscribe = this.storage.watch((event) => this.onStorageEvent(event));
    this.todayIso = this.currentIsoDate();
    this.scheduleRollover();
    await this.rescan();
  }

  /**
   * Stops watching. Unsettled changes are kept as differences between the tracked tasks and their
   * settled snapshots, so they are emitted on the next `start()` (like edits made while offline).
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.rolloverTimer) clearTimeout(this.rolloverTimer);
    this.rolloverTimer = undefined;
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
    }
    this.pending.clear();
    await this.scanning?.catch(() => {});
    await Promise.all([...this.notes.values()].map((state) => state.processing));
    await this.flush();
  }

  /** Persists tracker state for every note with unsaved changes. */
  async flush(): Promise<void> {
    await Promise.all(
      [...this.notes.values()]
        .filter((state) => state.saveTimer !== undefined)
        .map((state) => {
          clearTimeout(state.saveTimer);
          state.saveTimer = undefined;
          return this.saveState(state);
        }),
    );
  }

  updateSettings(settings: AppSettings): void {
    const previous = this.settings;
    this.settings = settings;
    const windowChanged =
      previous.dailyNotes.folder !== settings.dailyNotes.folder ||
      previous.dailyNotes.format !== settings.dailyNotes.format ||
      previous.agent.watch.pastDays !== settings.agent.watch.pastDays ||
      previous.agent.watch.futureDays !== settings.agent.watch.futureDays;
    if (!this.running) return;
    if (windowChanged) this.startRescan();
    if (previous.agent.settleMs !== settings.agent.settleMs) {
      for (const pending of this.pending.values()) this.schedule(pending);
    }
  }

  /** The user is typing on `line` of `notePath`: tasks on that line wait until they pause. */
  noteEditorActivity(notePath: string, line: number): void {
    let path: string;
    try {
      path = normalizePath(notePath);
    } catch {
      return;
    }
    this.activity.set(path, { line, at: this.now() });
    for (const pending of this.pending.values()) {
      if (pending.notePath === path) this.schedule(pending);
    }
  }

  getTasks(notePath: string): readonly TrackedTask[] {
    return this.notes.get(notePath)?.tasks ?? [];
  }

  findTask(
    taskId: string,
  ): { task: TrackedTask; notePath: string; date: string | null } | undefined {
    for (const state of this.notes.values()) {
      const task = state.tasks.find((t) => t.id === taskId);
      if (task) return { task, notePath: state.notePath, date: state.date };
    }
    return undefined;
  }

  watchedNotes(): string[] {
    return [...this.watched].sort();
  }

  /** Waits until pending reads/scans are processed (settle timers are not awaited). Test helper. */
  async idle(): Promise<void> {
    await this.scanning?.catch(() => {});
    await Promise.all([...this.notes.values()].map((state) => state.processing));
  }

  // ── Storage events & scanning ─────────────────────────────────────────────

  private onStorageEvent(event: StorageEvent): void {
    if (!this.running) return;
    this.checkRollover();
    if (!this.isInWindow(event.path)) return;
    this.watched.add(event.path);
    const state = this.notes.get(event.path);
    if (
      state &&
      !state.processing &&
      event.kind !== "deleted" &&
      event.version !== undefined &&
      event.version === state.contentVersion
    ) {
      return;
    }
    void this.enqueue(event.path, "event");
  }

  private startRescan(): void {
    void this.rescan().catch((error) => {
      this.logger.error("Daily note scan failed", { error: errorText(error) });
    });
  }

  private rescan(): Promise<void> {
    const run = (this.scanning ?? Promise.resolve()).catch(() => {}).then(() => this.scanOnce());
    this.scanning = run;
    const clear = () => {
      if (this.scanning === run) this.scanning = null;
    };
    run.then(clear, clear);
    return run;
  }

  private async scanOnce(): Promise<void> {
    if (!this.running) return;
    let folder: string;
    try {
      folder = normalizePath(this.settings.dailyNotes.folder || "");
    } catch (error) {
      this.logger.warn("Invalid daily notes folder; not watching", { error: errorText(error) });
      return;
    }
    const entries = await this.storage.list(folder ? { prefix: folder } : {});
    const next = new Set(entries.map((e) => e.path).filter((path) => this.isInWindow(path)));
    for (const path of this.watched) {
      if (!next.has(path)) this.unwatch(path);
    }
    this.watched = next;
    await Promise.all([...next].map((path) => this.enqueue(path, "scan")));
  }

  private unwatch(notePath: string): void {
    for (const [taskId, pending] of this.pending) {
      if (pending.notePath !== notePath) continue;
      if (pending.timer) clearTimeout(pending.timer);
      this.pending.delete(taskId);
    }
  }

  private enqueue(notePath: string, cause: "event" | "scan"): Promise<void> {
    const state = this.stateFor(notePath);
    if (state.processing) {
      state.rerun = state.rerun === "scan" || cause === "scan" ? "scan" : "event";
      return state.processing;
    }
    const run = async () => {
      let next: "event" | "scan" | null = cause;
      while (next && this.running) {
        state.rerun = null;
        try {
          await this.process(state, next);
        } catch (error) {
          this.logger.error("Failed to process daily note", { notePath, error: errorText(error) });
        }
        next = state.rerun;
      }
    };
    state.processing = run().finally(() => {
      state.processing = null;
    });
    return state.processing;
  }

  private async process(state: NoteState, cause: "event" | "scan"): Promise<void> {
    if (!state.loaded) await this.loadState(state);
    const file = await this.storage.read(state.notePath);
    if (!this.running) return;
    const at = this.now();
    if (!file) {
      if (state.tasks.length > 0) this.applyParse(state, [], null, at, cause === "scan");
      return;
    }
    if (file.version !== state.contentVersion) {
      const parsed = parseTasks(file.content);
      if (!state.tracked) {
        this.firstSight(state, parsed, file.version, at, cause);
        return;
      }
      // Changes found by a scan were made while we weren't watching: nobody is mid-typing them.
      this.applyParse(state, parsed, file.version, at, cause === "scan");
    }
    if (cause === "scan") this.reconcileUnsettled(state);
  }

  /**
   * A note without tracker state. Found by a scan (startup, window change, day rollover) its tasks
   * already existed: they become work only with `actOnExistingTasks`. Created while we watch, its
   * tasks are genuinely new and settle normally.
   */
  private firstSight(
    state: NoteState,
    parsed: ParsedTask[],
    contentVersion: string,
    at: number,
    cause: "event" | "scan",
  ): void {
    const { tasks } = trackTasks([], parsed, this.trackOptions(at));
    state.tasks = tasks;
    state.contentVersion = contentVersion;
    state.tracked = true;
    const act = cause === "scan" ? this.settings.agent.actOnExistingTasks : true;
    for (const task of tasks) {
      const actionable = !isBlankTaskText(task.text) && !isClosedStatus(task.status);
      if (act && actionable) {
        this.markPending(state, task.id, at, cause === "scan");
      } else {
        state.settled.set(task.id, {
          task: cloneTask(task),
          announced: !isBlankTaskText(task.text),
        });
      }
    }
    this.emitter.emit("tasks", { notePath: state.notePath, date: state.date, tasks: state.tasks });
    this.scheduleSave(state);
  }

  private applyParse(
    state: NoteState,
    parsed: ParsedTask[],
    contentVersion: string | null,
    at: number,
    immediate: boolean,
  ): void {
    const ghostIds = new Set(state.ghosts.map((g) => g.id));
    const { tasks, diff } = trackTasks(
      [...state.tasks, ...state.ghosts],
      parsed,
      this.trackOptions(at),
    );
    state.tasks = tasks;
    state.ghosts = diff.removed;
    state.contentVersion = contentVersion;
    state.tracked = true;

    const touched = new Set<string>();
    for (const task of diff.added) touched.add(task.id);
    for (const { task } of diff.updated) touched.add(task.id);
    for (const { task } of diff.statusChanged) touched.add(task.id);
    for (const task of diff.removed) if (!ghostIds.has(task.id)) touched.add(task.id);
    // A revived ghost settles against its snapshot like any other change.
    for (const task of tasks) if (ghostIds.has(task.id)) touched.add(task.id);
    for (const taskId of touched) this.markPending(state, taskId, at, immediate);

    this.emitter.emit("tasks", { notePath: state.notePath, date: state.date, tasks: state.tasks });
    this.scheduleSave(state);
  }

  /** Emits (right away) whatever differs from the settled snapshots, e.g. edits made offline. */
  private reconcileUnsettled(state: NoteState): void {
    const at = this.now();
    for (const task of state.tasks) {
      if (this.pending.has(task.id)) continue;
      const snapshot = state.settled.get(task.id);
      if (!snapshot || differs(snapshot, task)) this.markPending(state, task.id, at, true);
    }
    const alive = new Set(state.tasks.map((t) => t.id));
    for (const [taskId, snapshot] of state.settled) {
      if (alive.has(taskId) || this.pending.has(taskId)) continue;
      if (!state.ghosts.some((g) => g.id === taskId)) state.ghosts.push(snapshot.task);
      this.markPending(state, taskId, at, true);
    }
  }

  // ── Settling ──────────────────────────────────────────────────────────────

  private markPending(state: NoteState, taskId: string, at: number, immediate: boolean): void {
    let pending = this.pending.get(taskId);
    if (!pending) {
      pending = { taskId, notePath: state.notePath, lastChangeAt: at, immediate, timer: undefined };
      this.pending.set(taskId, pending);
    } else {
      pending.lastChangeAt = at;
      pending.immediate = pending.immediate && immediate;
    }
    this.schedule(pending);
  }

  private schedule(pending: PendingSettle): void {
    if (pending.timer) clearTimeout(pending.timer);
    const delay = Math.max(0, this.dueAt(pending) - this.now());
    pending.timer = setTimeout(() => this.settle(pending.taskId), delay);
  }

  private dueAt(pending: PendingSettle): number {
    if (pending.immediate) return pending.lastChangeAt;
    const settleMs = this.settings.agent.settleMs;
    let due = pending.lastChangeAt + settleMs;
    const activity = this.activity.get(pending.notePath);
    const task = this.notes.get(pending.notePath)?.tasks.find((t) => t.id === pending.taskId);
    if (activity && task && this.now() - activity.at <= this.activityWindowMs) {
      if (isOnTask(activity.line, task)) {
        due = Math.max(due, activity.at + this.activityWindowMs);
      } else {
        due = Math.min(due, pending.lastChangeAt + Math.min(this.quickSettleMs, settleMs));
      }
    }
    return due;
  }

  private settle(taskId: string): void {
    const pending = this.pending.get(taskId);
    if (!pending || !this.running) return;
    pending.timer = undefined;
    const due = this.dueAt(pending);
    if (due > this.now()) {
      this.schedule(pending);
      return;
    }
    this.pending.delete(taskId);
    const state = this.notes.get(pending.notePath);
    if (!state) return;

    const current = state.tasks.find((t) => t.id === taskId);
    const ghost = current ? undefined : state.ghosts.find((g) => g.id === taskId);
    const snapshot = state.settled.get(taskId);
    const event = this.eventFor(state, current, ghost, snapshot);

    if (current) {
      state.settled.set(taskId, {
        task: cloneTask(current),
        announced: (snapshot?.announced ?? false) || !isBlankTaskText(current.text),
      });
    } else {
      state.settled.delete(taskId);
      state.ghosts = state.ghosts.filter((g) => g.id !== taskId);
    }
    this.scheduleSave(state);
    if (event) this.emitter.emit("task", event);
  }

  private eventFor(
    state: NoteState,
    current: TrackedTask | undefined,
    ghost: TrackedTask | undefined,
    snapshot: SettledSnapshot | undefined,
  ): TaskEvent | null {
    const at = this.now();
    const base = { notePath: state.notePath, date: state.date, at };
    if (!current) {
      if (!snapshot?.announced) return null;
      return { ...base, kind: "removed", task: ghost ?? snapshot.task, previous: snapshot.task };
    }
    if (isBlankTaskText(current.text)) return null;
    if (!snapshot?.announced) {
      return isClosedStatus(current.status) ? null : { ...base, kind: "added", task: current };
    }
    const previous = snapshot.task;
    const changes: TaskChangeKind[] = [];
    if (previous.text !== current.text) changes.push("text");
    if (!sameNotes(previous.notes, current.notes)) changes.push("notes");
    const withChanges = changes.length > 0 ? { changes } : {};
    const wasClosed = isClosedStatus(previous.status);
    const isClosed = isClosedStatus(current.status);
    if (!wasClosed && isClosed) {
      return { ...base, kind: "completed", task: current, previous, ...withChanges };
    }
    if (wasClosed && !isClosed) {
      return { ...base, kind: "reopened", task: current, previous, ...withChanges };
    }
    if (changes.length > 0) return { ...base, kind: "updated", task: current, previous, changes };
    return null;
  }

  // ── Day rollover ──────────────────────────────────────────────────────────

  private currentIsoDate(): string {
    return toISODate(today(new Date(this.now())));
  }

  private scheduleRollover(): void {
    if (this.rolloverTimer) clearTimeout(this.rolloverTimer);
    const now = new Date(this.now());
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
    this.rolloverTimer = setTimeout(
      () => {
        this.rolloverTimer = undefined;
        this.checkRollover();
        if (this.running) this.scheduleRollover();
      },
      Math.max(1_000, next.getTime() - now.getTime()),
    );
  }

  /** Cheap enough to run on every storage event, which also covers timers delayed by sleep. */
  private checkRollover(): void {
    const iso = this.currentIsoDate();
    if (iso === this.todayIso) return;
    this.todayIso = iso;
    this.logger.info("Day rollover: rescanning daily notes", { today: iso });
    this.startRescan();
  }

  // ── State ─────────────────────────────────────────────────────────────────

  private isInWindow(path: string): boolean {
    const date = parseDailyNotePath(path, this.settings.dailyNotes);
    if (!date) return false;
    const { pastDays, futureDays } = this.settings.agent.watch;
    return isWithinWindow(date, this.todayLocal(), pastDays, futureDays);
  }

  private todayLocal(): LocalDate {
    return today(new Date(this.now()));
  }

  private stateFor(notePath: string): NoteState {
    let state = this.notes.get(notePath);
    if (!state) {
      const date = parseDailyNotePath(notePath, this.settings.dailyNotes);
      state = {
        notePath,
        date: date ? toISODate(date) : null,
        contentVersion: null,
        tasks: [],
        ghosts: [],
        settled: new Map(),
        loaded: false,
        tracked: false,
        processing: null,
        rerun: null,
        saveTimer: undefined,
      };
      this.notes.set(notePath, state);
    }
    return state;
  }

  private async loadState(state: NoteState): Promise<void> {
    try {
      const file = await this.storage.read(taskStatePath(state.notePath));
      const persisted = file ? parsePersistedState(file.content) : null;
      if (persisted && !state.tracked) {
        state.tasks = persisted.tasks;
        state.contentVersion = persisted.contentVersion;
        state.settled = new Map(Object.entries(persisted.settled));
        state.tracked = true;
      }
    } catch (error) {
      this.logger.warn("Failed to load task tracker state", {
        notePath: state.notePath,
        error: errorText(error),
      });
    }
    state.loaded = true;
  }

  private scheduleSave(state: NoteState): void {
    if (state.saveTimer) return;
    state.saveTimer = setTimeout(() => {
      state.saveTimer = undefined;
      void this.saveState(state);
    }, this.persistDelayMs);
  }

  private async saveState(state: NoteState): Promise<void> {
    const persisted: PersistedNoteState = {
      version: 1,
      notePath: state.notePath,
      contentVersion: state.contentVersion,
      tasks: state.tasks,
      settled: Object.fromEntries(state.settled),
    };
    try {
      await this.storage.write(taskStatePath(state.notePath), `${JSON.stringify(persisted)}\n`);
    } catch (error) {
      this.logger.warn("Failed to persist task tracker state", {
        notePath: state.notePath,
        error: errorText(error),
      });
    }
  }

  private trackOptions(at: number): { now: number; idFactory?: () => string } {
    return this.idFactory ? { now: at, idFactory: this.idFactory } : { now: at };
  }
}

export function taskStatePath(notePath: string): string {
  return `${TASK_STATE_DIR}/${hashString(notePath)}.json`;
}

/** The task's own line or one of its note lines (sub-bullets directly below it). */
function isOnTask(line: number, task: TrackedTask): boolean {
  return line >= task.line && line <= task.line + task.notes.length;
}

function differs(snapshot: SettledSnapshot, task: TrackedTask): boolean {
  if (!snapshot.announced) return !isBlankTaskText(task.text);
  const previous = snapshot.task;
  return (
    previous.text !== task.text ||
    isClosedStatus(previous.status) !== isClosedStatus(task.status) ||
    !sameNotes(previous.notes, task.notes)
  );
}

function sameNotes(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((note, i) => note === b[i]);
}

function cloneTask(task: TrackedTask): TrackedTask {
  return { ...task, notes: [...task.notes] };
}

function isTrackedTask(value: unknown): value is TrackedTask {
  if (typeof value !== "object" || value === null) return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.id === "string" &&
    typeof t.text === "string" &&
    typeof t.status === "string" &&
    typeof t.line === "number" &&
    Array.isArray(t.notes)
  );
}

function parsePersistedState(content: string): PersistedNoteState | null {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== 1 || !Array.isArray(r.tasks)) return null;
  const settled: Record<string, SettledSnapshot> = {};
  if (typeof r.settled === "object" && r.settled !== null) {
    for (const [id, value] of Object.entries(r.settled as Record<string, unknown>)) {
      const snap = value as Record<string, unknown> | null;
      if (snap && isTrackedTask(snap.task)) {
        settled[id] = { task: snap.task, announced: snap.announced === true };
      }
    }
  }
  return {
    version: 1,
    notePath: typeof r.notePath === "string" ? r.notePath : "",
    contentVersion: typeof r.contentVersion === "string" ? r.contentVersion : null,
    tasks: r.tasks.filter(isTrackedTask),
    settled,
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
