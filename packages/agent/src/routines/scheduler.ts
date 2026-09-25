import {
  createId,
  describeSchedule,
  formatMinuteOfDay,
  type LocalCalendar,
  type Logger,
  nextRunAfter,
  type RoutineNotification,
  type RoutineNotify,
  type RoutineRunTrigger,
  silentLogger,
  systemCalendar,
  type TaskAgentRecord,
  type TaskAgentStatus,
  type Thread,
  truncate,
} from "@ddl/core";
import type { Capability } from "../execution/types";
import type { TaskRecords } from "../orchestrator/records";
import type { SubagentManager, SubagentReport } from "../orchestrator/subagents";
import type { TaskBoard } from "../orchestrator/task-board";
import type { ThreadStore } from "../threads/types";
import type { RoutineDefinition } from "./catalog";
import { RoutineConflictError, RoutineInputError } from "./files";
import type { RoutineLibrary } from "./library";
import type { RoutineRunState } from "./state";

/** Task ids of routine runs: a run is a task-like record with its own thread, not a note line. */
export const ROUTINE_RUN_PREFIX = "run_";

export function isRoutineRunId(taskId: string | null | undefined): boolean {
  return typeof taskId === "string" && taskId.startsWith(ROUTINE_RUN_PREFIX);
}

/** A run stopped after this much working time (time waiting for the user doesn't count). */
export const MAX_ROUTINE_RUN_MS = 15 * 60_000;
/** A slot this late is a catch-up (the Mac slept, the daemon was down), not a scheduled run. */
const CATCH_UP_AFTER_MS = 2 * 60_000;
/** The scheduler looks again at least this often (clock changes, sleep, long timers). */
const TICK_MS = 60_000;
/** What the next run is told about the previous one. */
const RESULT_CHARS = 1_500;
const NOTIFICATION_CHARS = 240;

const FINISHED: readonly TaskAgentStatus[] = [
  "done",
  "failed",
  "cancelled",
  "ignored",
  "waiting_user",
];

/** What a run needs to know about its routine (the subagent's kickoff). */
export interface RoutineBrief {
  routineId: string;
  name: string;
  scheduleText?: string;
  trigger: RoutineRunTrigger;
  startedAt: number;
  instructions: string;
  notify: RoutineNotify;
  previous?: { startedAt: number; status: TaskAgentStatus; result: string };
}

/** A run with no `uses`, for the orchestrator to triage like a task. */
export interface RoutineRunTriage {
  taskId: string;
  name: string;
  scheduleText?: string;
  instructions: string;
}

export interface RoutineSchedulerOptions {
  library: RoutineLibrary;
  threads: ThreadStore;
  records: TaskRecords;
  board: TaskBoard;
  subagents: SubagentManager;
  /** Sends a run to the orchestrator to triage like a task. */
  triage: (run: RoutineRunTriage) => void;
  /** Forgets a run the orchestrator hasn't triaged yet. */
  dropTriage: (runId: string) => void;
  /** Capabilities agents can be granted here. */
  capabilities: () => readonly Capability[];
  onNotification: (notification: RoutineNotification) => void;
  now?: () => number;
  calendar?: LocalCalendar;
  logger?: Logger;
  maxRunMs?: number;
}

interface ActiveRun {
  routineId: string;
  name: string;
  trigger: RoutineRunTrigger;
  startedAt: number;
  /** Working time already spent waiting for the user. */
  pausedMs: number;
  pausedSince?: number;
  previous?: RoutineBrief["previous"];
  /** What the run said in finish_task (`changed`). */
  changed?: boolean;
  /** Its first turn ended (it counts as finished for the schedule, even if the user replies). */
  finished: boolean;
  /** Stopped for going over the time limit: its cancellation is reported as a failure. */
  timedOut: boolean;
}

/**
 * Starts routine runs when they're due, only while it's active (the agent runs here and is
 * enabled). A missed run catches up once, however many slots went by; the user switching the
 * agent back on doesn't count as missing anything. Each run is a thread with a task-like record
 * (`run_…`), done by a subagent (the routine's `uses`) or triaged by the orchestrator; runs have
 * a working-time limit, and runs beyond the schedule a daily budget.
 */
export class RoutineScheduler {
  private readonly options: RoutineSchedulerOptions;
  private readonly library: RoutineLibrary;
  private readonly now: () => number;
  private readonly calendar: LocalCalendar;
  private readonly logger: Logger;
  private readonly maxRunMs: number;
  private readonly runs = new Map<string, ActiveRun>();
  private active = false;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: RoutineSchedulerOptions) {
    this.options = options;
    this.library = options.library;
    this.now = options.now ?? Date.now;
    this.calendar = options.calendar ?? systemCalendar;
    this.logger = options.logger ?? silentLogger;
    this.maxRunMs = options.maxRunMs ?? MAX_ROUTINE_RUN_MS;
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Runs that were mid-triage when the agent last stopped can't resume: they failed. */
  reconcileAfterRestart(): void {
    const { records, board } = this.options;
    for (const record of records.all()) {
      if (!isRoutineRunId(record.taskId)) continue;
      if (record.status === "triaging" || record.status === "idle") {
        board.setStatus(record.taskId, "failed", {
          summary: "Interrupted",
          note: "Interrupted because the agent restarted before this run started.",
        });
      }
    }
    for (const definition of this.library.catalog.list()) {
      const run = this.library.state.get(definition.id)?.lastRun;
      const record = run ? records.get(run.runId) : undefined;
      if (run && record && record.status !== run.status) this.finalize(run.runId, record.status);
    }
  }

  /**
   * Starts scheduling. `catchUp`: slots missed while inactive run once now (after a restart or a
   * sleep); otherwise every routine starts again from its next slot (the user switched it on).
   */
  activate(options: { catchUp: boolean }): void {
    if (this.stopped) return;
    const wasActive = this.active;
    this.active = true;
    if (!wasActive && !options.catchUp) this.rescheduleAll();
    this.tick();
  }

  deactivate(): void {
    this.active = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  stop(): void {
    this.stopped = true;
    this.deactivate();
  }

  /** Starts what's due, stops runs over their time limit, and plans the next look. */
  tick(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.active || this.stopped) return;
    for (const definition of this.library.catalog.list()) {
      try {
        this.plan(definition);
      } catch (error) {
        this.logger.error("Routine scheduling failed", {
          routine: definition.id,
          error: errorText(error),
        });
      }
    }
    this.enforceTimeLimits();
    this.arm();
  }

  isRun(taskId: string | null | undefined): boolean {
    return isRoutineRunId(taskId);
  }

  /** A run of `routineId` is going (its first turn hasn't ended). */
  isRunning(routineId: string): boolean {
    for (const run of this.runs.values()) {
      if (run.routineId === routineId && !run.finished) return true;
    }
    return false;
  }

  /** Run now (the user or the agent): within the day's extra runs, never two at once. */
  runNow(idOrName: string): { routineId: string; threadId: string } {
    const definition = this.library.resolve(idOrName);
    const problem = definition.file.problems[0];
    if (problem) throw new RoutineInputError(`“${definition.name}” can't run: ${problem}`);
    if (this.isRunning(definition.id)) {
      throw new RoutineConflictError(`“${definition.name}” is running right now.`);
    }
    const state = this.library.state.get(definition.id);
    if (this.library.extraRunsLeft(state) === 0) {
      throw new RoutineConflictError(
        `“${definition.name}” already ran the most extra times allowed today; it runs again on its schedule.`,
      );
    }
    const { threadId } = this.startRun(definition, "manual");
    return { routineId: definition.id, threadId };
  }

  /** A run's record changed: time spent waiting for the user, and runs that finished. */
  onRecord(record: TaskAgentRecord): void {
    if (!isRoutineRunId(record.taskId)) return;
    const run = this.runs.get(record.taskId);
    if (run) {
      const now = this.now();
      if (record.status === "waiting_approval") run.pausedSince ??= now;
      else if (run.pausedSince !== undefined) {
        run.pausedMs += now - run.pausedSince;
        run.pausedSince = undefined;
      }
    }
    if (FINISHED.includes(record.status) && !this.options.subagents.isWorking(record.taskId)) {
      if (run?.timedOut && record.status === "cancelled") return;
      this.finalize(record.taskId, record.status);
    } else {
      this.library.changed();
    }
  }

  /** A run's subagent ended its turn (its `changed`, when the routine asked for it). */
  onSubagentFinished(report: SubagentReport): void {
    const run = this.runs.get(report.taskId);
    if (run && report.changed !== undefined) run.changed = report.changed;
    this.finalize(report.taskId, report.status);
  }

  /** What the run's subagent is told about its routine. */
  brief(taskId: string): RoutineBrief | undefined {
    if (!isRoutineRunId(taskId)) return undefined;
    const run = this.runs.get(taskId);
    const routineId = run?.routineId ?? this.routineOf(taskId);
    if (!routineId) return undefined;
    const definition = this.library.definition(routineId);
    const lastRun = this.library.state.get(routineId)?.lastRun;
    const self = lastRun?.runId === taskId ? lastRun : undefined;
    const name = definition?.name ?? run?.name ?? this.options.records.get(taskId)?.text;
    if (!name) return undefined;
    const scheduleText = definition?.file.parsedSchedule
      ? describeSchedule(definition.file.parsedSchedule)
      : undefined;
    return {
      routineId,
      name,
      ...(scheduleText ? { scheduleText } : {}),
      trigger: run?.trigger ?? self?.trigger ?? "manual",
      startedAt: run?.startedAt ?? self?.startedAt ?? this.now(),
      instructions: definition?.file.instructions ?? "",
      notify: definition?.file.notify ?? "always",
      ...(run?.previous ? { previous: run.previous } : {}),
    };
  }

  // ── Scheduling ────────────────────────────────────────────────────────────

  private plan(definition: RoutineDefinition): void {
    const { file } = definition;
    const state = this.library.state.get(definition.id);
    const schedule = file.parsedSchedule;
    if (!schedule || file.paused || file.problems.length > 0) {
      if (state && (state.nextRunAt !== null || state.scheduleKey !== null)) {
        this.library.state.update(definition.id, definition.path, () => ({
          scheduleKey: null,
          nextRunAt: null,
        }));
      }
      return;
    }
    const now = this.now();
    if (!state || state.scheduleKey !== file.schedule || state.nextRunAt === null) {
      this.library.state.update(definition.id, definition.path, () => ({
        scheduleKey: file.schedule,
        nextRunAt: nextRunAfter(schedule, now, this.calendar),
      }));
      return;
    }
    if (state.nextRunAt > now) return;
    const missed = state.nextRunAt;
    const nextRunAt = nextRunAfter(schedule, now, this.calendar);
    this.library.state.update(definition.id, definition.path, () => ({ nextRunAt }));
    if (this.isRunning(definition.id)) {
      this.logger.info("Routine slot skipped: the previous run is still going", {
        routine: definition.id,
      });
      return;
    }
    const trigger: RoutineRunTrigger = now - missed > CATCH_UP_AFTER_MS ? "catch_up" : "schedule";
    this.startRun(definition, trigger, missed);
  }

  private rescheduleAll(): void {
    const now = this.now();
    for (const definition of this.library.catalog.list()) {
      const schedule = definition.file.parsedSchedule;
      if (!schedule || definition.file.paused || definition.file.problems.length > 0) continue;
      this.library.state.update(definition.id, definition.path, () => ({
        scheduleKey: definition.file.schedule,
        nextRunAt: nextRunAfter(schedule, now, this.calendar),
      }));
    }
  }

  private enforceTimeLimits(): void {
    const now = this.now();
    for (const [runId, run] of this.runs) {
      if (run.finished || run.timedOut) continue;
      if (this.workingTime(run, now) <= this.maxRunMs) continue;
      run.timedOut = true;
      const minutes = Math.round(this.maxRunMs / 60_000);
      const note = `Stopped: this run went over the ${minutes}-minute limit for a routine's run.`;
      this.options.dropTriage(runId);
      void this.options.subagents
        .cancel(runId, note)
        .then(() => {
          this.options.board.setStatus(runId, "failed", { summary: "Took too long", note });
        })
        .catch((error: unknown) => {
          this.logger.error("Couldn't stop a routine run", { runId, error: errorText(error) });
        });
    }
  }

  private workingTime(run: ActiveRun, now: number): number {
    const waiting = run.pausedSince !== undefined ? now - run.pausedSince : 0;
    return now - run.startedAt - run.pausedMs - waiting;
  }

  private arm(): void {
    if (!this.active || this.stopped) return;
    const now = this.now();
    let due = now + TICK_MS;
    for (const definition of this.library.catalog.list()) {
      const next = this.library.state.get(definition.id)?.nextRunAt;
      if (next != null) due = Math.min(due, next);
    }
    for (const run of this.runs.values()) {
      if (run.finished || run.timedOut || run.pausedSince !== undefined) continue;
      due = Math.min(due, now + this.maxRunMs - this.workingTime(run, now) + 1);
    }
    this.timer = setTimeout(() => this.tick(), Math.max(0, due - now));
    this.timer.unref?.();
  }

  // ── Runs ──────────────────────────────────────────────────────────────────

  private startRun(
    definition: RoutineDefinition,
    trigger: RoutineRunTrigger,
    missedAt?: number,
  ): { runId: string; threadId: string } {
    const { records, threads, board } = this.options;
    const now = this.now();
    const runId = createId(ROUTINE_RUN_PREFIX.slice(0, -1));
    const scheduleText = definition.file.parsedSchedule
      ? describeSchedule(definition.file.parsedSchedule)
      : undefined;
    const before = this.library.state.get(definition.id)?.lastRun;
    const previous =
      before && before.finishedAt !== undefined
        ? { startedAt: before.startedAt, status: before.status, result: before.result ?? "" }
        : undefined;
    records.ensure({
      taskId: runId,
      notePath: definition.path,
      date: this.library.todayISO(),
      text: definition.name,
      line: 0,
    });
    const thread = threads.create({
      taskId: runId,
      notePath: definition.path,
      title: definition.name,
      routineId: definition.id,
    });
    records.update(runId, { threadId: thread.id });
    this.runs.set(runId, {
      routineId: definition.id,
      name: definition.name,
      trigger,
      startedAt: now,
      pausedMs: 0,
      ...(previous ? { previous } : {}),
      finished: false,
      timedOut: false,
    });
    const today = this.library.todayISO();
    this.library.state.update(definition.id, definition.path, (state) => ({
      lastRun: { runId, threadId: thread.id, trigger, status: "triaging", startedAt: now },
      runs: [thread.id, ...state.runs],
      ...(trigger === "manual"
        ? {
            extraRuns: {
              date: today,
              count: (state.extraRuns?.date === today ? state.extraRuns.count : 0) + 1,
            },
          }
        : {}),
    }));
    const note = this.startNote(trigger, scheduleText, missedAt);
    const uses = definition.file.uses;
    if (uses.length === 0) {
      board.setStatus(runId, "triaging", { note });
      this.options.triage({
        taskId: runId,
        name: definition.name,
        ...(scheduleText ? { scheduleText } : {}),
        instructions: definition.file.instructions,
      });
    } else {
      const available = this.options.capabilities();
      const granted = uses.filter((use) => available.includes(use));
      if (granted.length === 0) {
        board.setStatus(runId, "failed", {
          summary: "Can't run here",
          note: `${note} — it uses ${uses.join(", ")}, and none of them is available here.`,
        });
      } else {
        board.setStatus(runId, "working", { note });
        void this.options.subagents
          .spawn({
            taskId: runId,
            goal: `Run the routine “${definition.name}”`,
            capabilities: granted,
          })
          .catch((error: unknown) => {
            board.setStatus(runId, "failed", {
              summary: "Couldn't start",
              note: `The run couldn't start: ${errorText(error)}`,
            });
          });
      }
    }
    this.logger.info("Routine run started", { routine: definition.id, trigger, runId });
    this.library.changed();
    return { runId, threadId: thread.id };
  }

  private startNote(
    trigger: RoutineRunTrigger,
    scheduleText: string | undefined,
    missedAt: number | undefined,
  ): string {
    switch (trigger) {
      case "manual":
        return "Run now";
      case "catch_up": {
        const at = missedAt === undefined ? null : this.calendar.parts(missedAt);
        const when = at ? ` at ${formatMinuteOfDay(at.hour * 60 + at.minute)}` : "";
        return `Catch-up run · missed${when} while the agent wasn't running`;
      }
      case "schedule":
        return scheduleText ? `Scheduled run · ${scheduleText}` : "Scheduled run";
    }
  }

  /** Records how a run ended (every time it ends a turn) and notifies once, per `notify`. */
  private finalize(runId: string, status: TaskAgentStatus): void {
    if (!FINISHED.includes(status)) return;
    const run = this.runs.get(runId);
    const routineId = run?.routineId ?? this.routineOf(runId);
    if (!routineId) return;
    const state = this.library.state.get(routineId);
    const lastRun = state?.lastRun;
    if (run) run.finished = true;
    if (!state || lastRun?.runId !== runId) {
      this.library.changed();
      return;
    }
    const record = this.options.records.get(runId);
    const thread = this.options.threads.get(lastRun.threadId);
    const result = thread ? latestResult(thread) : "";
    const changed = run?.changed ?? lastRun.changed;
    const updated: RoutineRunState = {
      ...lastRun,
      status,
      finishedAt: lastRun.finishedAt ?? this.now(),
      ...(record?.summary ? { summary: record.summary } : {}),
      ...(result ? { result } : {}),
      ...(changed !== undefined ? { changed } : {}),
      notified: true,
    };
    const path = this.library.definition(routineId)?.path ?? state.path;
    this.library.state.update(routineId, path, () => ({ lastRun: updated }));
    if (!lastRun.notified) this.notify(routineId, updated);
    this.library.changed();
  }

  private notify(routineId: string, run: RoutineRunState): void {
    const definition = this.library.definition(routineId);
    const notify = definition?.file.notify ?? "always";
    if (!shouldNotify(notify, run)) return;
    const name = definition?.name ?? this.options.records.get(run.runId)?.text ?? "Routine";
    const result = firstLines(run.result ?? "") || run.summary || "";
    const body =
      run.status === "failed"
        ? `Failed: ${run.summary ?? result ?? "the run stopped"}`
        : run.status === "waiting_user"
          ? `Needs you: ${run.summary ?? result}`
          : result || "Done.";
    try {
      this.options.onNotification({
        routineId,
        title: name,
        body: truncate(body, NOTIFICATION_CHARS),
        threadId: run.threadId,
        status: run.status,
        at: this.now(),
      });
    } catch (error) {
      this.logger.error("Routine notification failed", { error: errorText(error) });
    }
  }

  private routineOf(runId: string): string | undefined {
    const threadId = this.options.records.get(runId)?.threadId;
    const thread = threadId
      ? this.options.threads.get(threadId)
      : this.options.threads.findByTask(runId);
    return thread?.routineId;
  }
}

/** Whether a finished run notifies: failures and questions do unless `never`; results per `notify`. */
export function shouldNotify(
  notify: RoutineNotify,
  run: Pick<RoutineRunState, "status" | "changed">,
): boolean {
  if (notify === "never") return false;
  switch (run.status) {
    case "failed":
    case "waiting_user":
      return true;
    case "done":
      return notify === "always" || run.changed !== false;
    default:
      return false;
  }
}

/** The run's report: its latest agent message, shortened. */
function latestResult(thread: Thread): string {
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    const message = thread.messages[i]!;
    if (message.kind === "text" && message.role === "agent" && message.text.trim()) {
      return truncate(message.text.trim(), RESULT_CHARS);
    }
  }
  return "";
}

function firstLines(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/, "").trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(" ");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
