import {
  decodePersistedTaskState,
  encodePersistedTaskState,
  PERSISTED_PATHS,
  PersistedFile,
  type PersistedTaskState,
} from "@ddl/contract";
import {
  type AppSettings,
  Emitter,
  hashString,
  isAgentLine,
  isBlankTaskText,
  isClosedStatus,
  isTaskLine,
  isWithinWindow,
  type LocalDate,
  type Logger,
  normalizePath,
  type ParsedTask,
  parseDailyNotePath,
  parseTasks,
  silentLogger,
  type TaskChangeKind,
  type TrackedTask,
  today,
  toISODate,
  trackTasks,
  type Unsubscribe,
} from "@ddl/core";
import type { StorageEvent, StorageProvider } from "@ddl/storage";
import { mayBeRequest } from "./prose";
import type { NoteEvent, TaskEvent } from "./types";

export const TASK_STATE_DIR = PERSISTED_PATHS.taskState;

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
  /** A settled change to the note's other lines (see `NoteEvent`). */
  note: NoteEvent;
  /**
   * The note's unsettled lines that may be requests (none: the ones noticed before are gone).
   * Emitted before the settle delay, only when which lines they are changes, never per keystroke.
   */
  noticed: NoteEvent;
  /** Every re-parse of a watched note (unsettled): keeps lines/text of records current. */
  tasks: { notePath: string; date: string | null; tasks: readonly TrackedTask[] };
  /** A watched note changed on disk (not found by a scan), before anything settles. */
  changed: { notePath: string };
};

/** Read access to the tracked tasks, shared with the orchestrator. */
export interface TaskLookup {
  findTask(
    taskId: string,
  ): { task: TrackedTask; notePath: string; date: string | null } | undefined;
  getTasks(notePath: string): readonly TrackedTask[];
  /** The note's content as of the last parse (null when not watched or deleted). */
  getContent(notePath: string): string | null;
}

/** The user's non-task lines (no blank, task or agent-written lines), trimmed, in note order. */
function userProse(content: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  const lines = content.split("\n");
  for (let line = 0; line < lines.length; line++) {
    const raw = lines[line]!.replace(/\r$/, "");
    const text = raw.trim();
    if (text === "" || isTaskLine(raw) || isAgentLine(raw)) continue;
    out.push({ line, text });
  }
  return out;
}

/** Lines of `next` whose text isn't in `previous` (as many times), i.e. new or edited lines. */
function newProse(
  next: ReadonlyArray<{ line: number; text: string }>,
  previous: readonly string[],
): Array<{ line: number; text: string }> {
  const left = new Map<string, number>();
  for (const text of previous) left.set(text, (left.get(text) ?? 0) + 1);
  const out: Array<{ line: number; text: string }> = [];
  for (const entry of next) {
    const count = left.get(entry.text) ?? 0;
    if (count > 0) left.set(entry.text, count - 1);
    else out.push(entry);
  }
  return out;
}

interface SettledSnapshot {
  /** The task as of the last settled event: the baseline for the next one. */
  task: TrackedTask;
  /** The orchestrator knows about this task (it had text when it settled). */
  announced: boolean;
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
  /** The note as of the last read (null once deleted). */
  content: string | null;
  prose: ProseState;
}

/** Settling of the note's non-task lines, which the orchestrator sees as `note` events. */
interface ProseState {
  /** The user's non-task lines as of the last settle; null until the note was first read. */
  settled: string[] | null;
  lastChangeAt: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Which lines the last `noticed` event named (their numbers), "" for none. */
  noticed: string;
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
  private readonly stateFiles = new Map<string, PersistedFile<PersistedTaskState>>();
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
    for (const state of this.notes.values()) this.cancelProse(state);
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
    const state = this.notes.get(path);
    if (state?.prose.timer) this.scheduleProse(state);
  }

  /** Whether tasks in this note reach the orchestrator (a daily note inside the window). */
  watches(notePath: string): boolean {
    try {
      return this.isInWindow(normalizePath(notePath));
    } catch {
      return false;
    }
  }

  getTasks(notePath: string): readonly TrackedTask[] {
    return this.notes.get(notePath)?.tasks ?? [];
  }

  getContent(notePath: string): string | null {
    return this.notes.get(notePath)?.content ?? null;
  }

  /**
   * Resolves once the editor hasn't reported typing in the note for the activity window (or after
   * `maxWaitMs`), so the agent's own edits land between keystrokes rather than under them.
   */
  async waitForPause(notePath: string, maxWaitMs = 8_000): Promise<void> {
    let path: string;
    try {
      path = normalizePath(notePath);
    } catch {
      return;
    }
    const deadline = this.now() + maxWaitMs;
    for (;;) {
      const activity = this.activity.get(path);
      const quietFor = activity ? this.now() - activity.at : Number.POSITIVE_INFINITY;
      const left = deadline - this.now();
      if (quietFor >= this.activityWindowMs || left <= 0) return;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(10, Math.min(this.activityWindowMs - quietFor, left))),
      );
    }
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
    const state = this.notes.get(notePath);
    if (state) this.cancelProse(state);
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
      // An event that arrived after the loop last looked, before this callback ran.
      const missed = state.rerun;
      state.rerun = null;
      if (missed && this.running) void this.enqueue(notePath, missed);
    });
    return state.processing;
  }

  private async process(state: NoteState, cause: "event" | "scan"): Promise<void> {
    if (!state.loaded) await this.loadState(state);
    const file = await this.storage.read(state.notePath);
    if (!this.running) return;
    if (cause === "event") this.emitter.emit("changed", { notePath: state.notePath });
    const at = this.now();
    if (!file) {
      state.content = null;
      this.cancelProse(state);
      state.prose.settled = null;
      if (state.tasks.length > 0) this.applyParse(state, [], null, at, cause === "scan");
      return;
    }
    // Like tasks: a note that appears while we watch is new writing; one a scan finds already existed.
    const created = state.content === null && cause === "event";
    state.content = file.content;
    if (file.version !== state.contentVersion) {
      const parsed = parseTasks(file.content);
      if (!state.tracked) {
        this.firstSight(state, parsed, file.version, at, cause);
        this.trackProse(state, at, created);
        return;
      }
      // Changes found by a scan were made while we weren't watching: nobody is mid-typing them.
      this.applyParse(state, parsed, file.version, at, cause === "scan");
    }
    this.trackProse(state, at, created);
    if (cause === "scan") this.reconcileUnsettled(state);
  }

  // ── Prose (the note's non-task lines) ─────────────────────────────────────

  /**
   * New or edited user lines settle like tasks do, as one `note` event per pause. Lines that only
   * disappeared keep their place in the snapshot until the next settle, so cutting and pasting a
   * line isn't news. The first read of a note found by a scan only takes the snapshot; a note
   * `created` while we watch starts from nothing.
   */
  private trackProse(state: NoteState, at: number, created: boolean): void {
    const prose = userProse(state.content ?? "");
    if (state.prose.settled === null) {
      if (!created) {
        state.prose.settled = prose.map((entry) => entry.text);
        return;
      }
      state.prose.settled = [];
    }
    const requests = newProse(prose, state.prose.settled).filter((entry) =>
      mayBeRequest(entry.text),
    );
    this.notice(state, requests);
    if (requests.length === 0) return;
    state.prose.lastChangeAt = at;
    this.scheduleProse(state);
  }

  /** Tells which unsettled lines may be requests, when that changed. */
  private notice(state: NoteState, lines: Array<{ line: number; text: string }>): void {
    const noticed = lines.map((entry) => entry.line).join(",");
    if (noticed === state.prose.noticed) return;
    state.prose.noticed = noticed;
    this.emitter.emit("noticed", {
      notePath: state.notePath,
      date: state.date,
      lines,
      at: this.now(),
    });
  }

  private scheduleProse(state: NoteState): void {
    if (state.prose.timer) clearTimeout(state.prose.timer);
    const delay = Math.max(0, this.proseDueAt(state) - this.now());
    state.prose.timer = setTimeout(() => this.settleProse(state.notePath), delay);
  }

  /** Settle delay after the last change, later while the user is still typing in the note. */
  private proseDueAt(state: NoteState): number {
    let due = state.prose.lastChangeAt + this.settings.agent.settleMs;
    const activity = this.activity.get(state.notePath);
    if (activity && this.now() - activity.at <= this.activityWindowMs) {
      due = Math.max(due, activity.at + this.activityWindowMs);
    }
    return due;
  }

  private settleProse(notePath: string): void {
    const state = this.notes.get(notePath);
    if (!state || !this.running) return;
    state.prose.timer = undefined;
    if (this.proseDueAt(state) > this.now()) {
      this.scheduleProse(state);
      return;
    }
    const prose = userProse(state.content ?? "");
    const lines = newProse(prose, state.prose.settled ?? []).filter((entry) =>
      mayBeRequest(entry.text),
    );
    state.prose.settled = prose.map((entry) => entry.text);
    if (lines.length === 0) {
      this.notice(state, []);
      return;
    }
    // The orchestrator takes the noticed lines over with this event.
    state.prose.noticed = "";
    this.emitter.emit("note", { notePath, date: state.date, lines, at: this.now() });
  }

  private cancelProse(state: NoteState): void {
    if (state.prose.timer) clearTimeout(state.prose.timer);
    state.prose.timer = undefined;
    this.notice(state, []);
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
      const actionable = !isBlankTaskText(task.text) && !isClosedStatus(task.status) && !task.agent;
      if (act && actionable) {
        this.markPending(state, task.id, at, cause === "scan");
      } else {
        state.settled.set(task.id, {
          task: cloneTask(task),
          announced: !isBlankTaskText(task.text) && !task.agent,
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
    const wasAgents = new Set(state.tasks.filter((t) => t.agent).map((t) => t.id));
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
    // A revived ghost settles against its snapshot like any other change; so does an agent task
    // whose marker the user deleted (it's theirs now).
    for (const task of tasks) {
      if (ghostIds.has(task.id) || (wasAgents.has(task.id) && !task.agent)) touched.add(task.id);
    }
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
    if (this.dueAt(pending) > this.now()) {
      this.schedule(pending);
      return;
    }
    const state = this.notes.get(pending.notePath);
    if (!state) {
      this.pending.delete(taskId);
      return;
    }
    // Tasks written together are due together, but each timer waits `due - now()`, so they can
    // fire in any order and turns apart. Settling every due task of the note in one pass, top to
    // bottom, hands them to the orchestrator as one batch in note order.
    const order = new Map(state.tasks.map((task, index) => [task.id, index]));
    const position = (id: string) => order.get(id) ?? Number.POSITIVE_INFINITY;
    const due = [...this.pending.values()]
      .filter(
        (p) => p.notePath === pending.notePath && (p === pending || this.dueAt(p) <= this.now()),
      )
      .sort((a, b) => position(a.taskId) - position(b.taskId));
    for (const next of due) {
      if (next.timer) clearTimeout(next.timer);
      this.pending.delete(next.taskId);
      this.settleTask(state, next.taskId);
    }
  }

  private settleTask(state: NoteState, taskId: string): void {
    const current = state.tasks.find((t) => t.id === taskId);
    const ghost = current ? undefined : state.ghosts.find((g) => g.id === taskId);
    const snapshot = state.settled.get(taskId);
    const event = this.eventFor(state, current, ghost, snapshot);

    if (current) {
      state.settled.set(taskId, {
        task: cloneTask(current),
        // The agent's own tasks aren't requests: they're announced once the user removes the marker.
        announced:
          (snapshot?.announced ?? false) || (!isBlankTaskText(current.text) && !current.agent),
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
    if (current.agent && !snapshot?.announced) return null;
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
        content: null,
        prose: { settled: null, lastChangeAt: 0, timer: undefined, noticed: "" },
      };
      this.notes.set(notePath, state);
    }
    return state;
  }

  /**
   * Tracker state follows the shared file rules (format in @ddl/contract): a corrupt file (or one
   * recorded for another note) is moved aside, one from a newer app is never overwritten.
   */
  private async loadState(state: NoteState): Promise<void> {
    try {
      const result = await this.stateFile(state.notePath).load();
      if (result.status === "loaded" && !state.tracked) {
        state.tasks = result.value.tasks;
        state.contentVersion = result.value.contentVersion;
        state.settled = new Map(Object.entries(result.value.settled));
        state.tracked = true;
        if (result.issues.length > 0) this.scheduleSave(state);
      } else if ((result.status === "quarantined" || result.status === "newer") && !state.tracked) {
        await this.baselineExisting(state);
      }
    } catch (error) {
      this.logger.warn("Failed to load task tracker state", {
        notePath: state.notePath,
        error: errorText(error),
      });
    }
    state.loaded = true;
  }

  /**
   * Tracker state existed but cannot be used, so the note is not new: its current tasks count as
   * already known (as without `actOnExistingTasks`) rather than being acted on again under fresh
   * ids. Later edits are detected against this baseline.
   */
  private async baselineExisting(state: NoteState): Promise<void> {
    const file = await this.storage.read(state.notePath);
    if (!file) return;
    const { tasks } = trackTasks([], parseTasks(file.content), this.trackOptions(this.now()));
    state.tasks = tasks;
    state.contentVersion = file.version;
    state.settled = new Map(
      tasks.map((task) => [
        task.id,
        { task: cloneTask(task), announced: !isBlankTaskText(task.text) && !task.agent },
      ]),
    );
    state.tracked = true;
    this.emitter.emit("tasks", { notePath: state.notePath, date: state.date, tasks: state.tasks });
    this.scheduleSave(state);
  }

  private stateFile(notePath: string): PersistedFile<PersistedTaskState> {
    let file = this.stateFiles.get(notePath);
    if (!file) {
      file = new PersistedFile({
        storage: this.storage,
        path: taskStatePath(notePath),
        decode: (text) => decodePersistedTaskState(text, notePath),
        logger: this.logger,
        now: this.now,
      });
      this.stateFiles.set(notePath, file);
    }
    return file;
  }

  private scheduleSave(state: NoteState): void {
    if (state.saveTimer) return;
    state.saveTimer = setTimeout(() => {
      state.saveTimer = undefined;
      void this.saveState(state);
    }, this.persistDelayMs);
  }

  private async saveState(state: NoteState): Promise<void> {
    try {
      await this.stateFile(state.notePath).save(() =>
        encodePersistedTaskState({
          notePath: state.notePath,
          contentVersion: state.contentVersion,
          tasks: state.tasks,
          settled: Object.fromEntries(state.settled),
        }),
      );
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
  if (!snapshot.announced) return !isBlankTaskText(task.text) && !task.agent;
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
