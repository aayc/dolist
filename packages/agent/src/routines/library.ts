import {
  describeSchedule,
  Listeners,
  type LocalCalendar,
  type Logger,
  nextRunAfter,
  type Routine,
  type RoutineFilePatch,
  type RoutineRun,
  type RoutineUse,
  routineIdForPath,
  silentLogger,
  systemCalendar,
  type TaskAgentStatus,
  today,
  toISODate,
  type Unsubscribe,
} from "@ddl/core";
import type { StorageProvider } from "@ddl/storage";
import { RoutineCatalog, type RoutineDefinition } from "./catalog";
import { type NewRoutine, patchRoutineFile, UnknownRoutineError, writeNewRoutine } from "./files";
import { ROUTINES_STATE_PATH, type RoutineState, RoutineStateStore } from "./state";

/** Runs a routine may start per local day beyond its schedule (Run now, the agent's run_routine). */
export const EXTRA_RUNS_PER_DAY = 5;

/** What the live runtime knows about a run that the saved state may not have yet. */
export interface LiveRun {
  status: TaskAgentStatus;
  summary?: string;
}

export interface RoutineLibraryOptions {
  storage: StorageProvider;
  now?: () => number;
  calendar?: LocalCalendar;
  logger?: Logger;
  /** Never writes state (another device runs the agent): follows the synced file instead. */
  readOnly?: boolean;
  /** The live status of a run, while it runs here. */
  liveRun?: (runId: string) => LiveRun | undefined;
}

/**
 * The routines as the user sees them: each routine file joined with the scheduler's state. Also
 * writes the files the user asks for (new routine, pause, resume). It never schedules anything;
 * that's the RoutineScheduler, which only exists where the agent runs.
 */
export class RoutineLibrary {
  readonly catalog: RoutineCatalog;
  readonly state: RoutineStateStore;
  private readonly storage: StorageProvider;
  private readonly now: () => number;
  private readonly calendar: LocalCalendar;
  private readonly readOnly: boolean;
  private readonly liveRun: (runId: string) => LiveRun | undefined;
  private readonly listeners = new Listeners();
  private readonly disposers: Unsubscribe[] = [];
  private changeQueued = false;

  constructor(options: RoutineLibraryOptions) {
    this.storage = options.storage;
    this.now = options.now ?? Date.now;
    this.calendar = options.calendar ?? systemCalendar;
    this.readOnly = options.readOnly ?? false;
    this.liveRun = options.liveRun ?? (() => undefined);
    const logger = options.logger ?? silentLogger;
    this.catalog = new RoutineCatalog({ storage: options.storage, logger });
    this.state = new RoutineStateStore({
      storage: options.storage,
      now: this.now,
      logger,
      readOnly: this.readOnly,
    });
  }

  async start(): Promise<void> {
    this.disposers.push(
      this.catalog.on(() => this.changed()),
      this.state.on(() => this.changed()),
    );
    if (this.readOnly) {
      this.disposers.push(
        this.storage.watch((event) => {
          if (event.path === ROUTINES_STATE_PATH && event.kind !== "deleted") {
            void this.state.load();
          }
        }),
      );
    }
    await Promise.all([this.catalog.start(), this.state.load()]);
  }

  stop(): void {
    this.catalog.stop();
    for (const dispose of this.disposers.splice(0)) dispose();
    this.listeners.clear();
  }

  /** Something the user sees changed (a file, a next run, a last run). Coalesced per microtask. */
  on(listener: () => void): Unsubscribe {
    return this.listeners.add(listener);
  }

  /** Tells listeners the routines changed (e.g. a run's live status moved). */
  changed(): void {
    if (this.changeQueued) return;
    this.changeQueued = true;
    queueMicrotask(() => {
      this.changeQueued = false;
      this.listeners.emit();
    });
  }

  list(): Routine[] {
    return this.catalog.list().map((definition) => this.summarize(definition));
  }

  get(id: string): Routine | undefined {
    const definition = this.catalog.get(id);
    return definition ? this.summarize(definition) : undefined;
  }

  definition(id: string): RoutineDefinition | undefined {
    return this.catalog.get(id);
  }

  /** By id or by name (ignoring case). */
  resolve(idOrName: string): RoutineDefinition {
    const definition = this.catalog.get(idOrName) ?? this.catalog.findByName(idOrName);
    if (!definition) throw new UnknownRoutineError(`named “${idOrName}”`);
    return definition;
  }

  async create(input: NewRoutine): Promise<Routine> {
    const path = await writeNewRoutine(this.storage, input);
    await this.catalog.reload(path);
    return this.require(routineIdForPath(path));
  }

  async update(id: string, patch: RoutineFilePatch): Promise<Routine> {
    const definition = this.catalog.get(id);
    if (!definition) throw new UnknownRoutineError(`with id ${id}`);
    await patchRoutineFile(this.storage, definition.path, patch);
    await this.catalog.reload(definition.path);
    return this.require(id);
  }

  setPaused(id: string, paused: boolean): Promise<Routine> {
    return this.update(id, { paused });
  }

  /** Runs still allowed today beyond the schedule. */
  extraRunsLeft(state: RoutineState | undefined): number {
    const used = state?.extraRuns?.date === this.todayISO() ? state.extraRuns.count : 0;
    return Math.max(0, EXTRA_RUNS_PER_DAY - used);
  }

  todayISO(): string {
    return toISODate(today(new Date(this.now())));
  }

  /** When it runs next as far as anyone can tell (the scheduler's plan, else its schedule from now). */
  plannedNextRun(definition: RoutineDefinition, state: RoutineState | undefined): number | null {
    const { parsedSchedule, paused, problems } = definition.file;
    if (!parsedSchedule || paused || problems.length > 0) return null;
    const now = this.now();
    const planned =
      state?.scheduleKey === definition.file.schedule ? (state?.nextRunAt ?? null) : null;
    if (planned !== null && planned > now) return planned;
    return nextRunAfter(parsedSchedule, now, this.calendar);
  }

  summarize(definition: RoutineDefinition): Routine {
    const { file } = definition;
    const state = this.state.get(definition.id);
    const nextRunAt = this.plannedNextRun(definition, state);
    const lastRun = state?.lastRun ? this.publicRun(state.lastRun) : undefined;
    return {
      id: definition.id,
      path: definition.path,
      name: definition.name,
      schedule: file.schedule ?? "",
      ...(file.parsedSchedule ? { scheduleText: describeSchedule(file.parsedSchedule) } : {}),
      notify: file.notify,
      uses: [...file.uses] as RoutineUse[],
      paused: file.paused,
      instructions: file.instructions,
      ...(file.problems[0] ? { error: file.problems[0] } : {}),
      ...(nextRunAt !== null ? { nextRunAt } : {}),
      ...(lastRun ? { lastRun } : {}),
      runCount: state?.runs.length ?? 0,
      extraRunsLeft: this.extraRunsLeft(state),
    };
  }

  private publicRun(run: NonNullable<RoutineState["lastRun"]>): RoutineRun {
    const live = this.liveRun(run.runId);
    const summary = live?.summary ?? run.summary;
    return {
      threadId: run.threadId,
      trigger: run.trigger,
      status: live?.status ?? run.status,
      startedAt: run.startedAt,
      ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
      ...(summary ? { summary } : {}),
      ...(run.changed !== undefined ? { changed: run.changed } : {}),
    };
  }

  private require(id: string): Routine {
    const routine = this.get(id);
    if (!routine) throw new UnknownRoutineError(`with id ${id}`);
    return routine;
  }
}
