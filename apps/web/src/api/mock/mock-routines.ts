import {
  type CreateRoutineRequest,
  describeSchedule,
  isRoutinePath,
  nextRunAfter,
  parseRoutineFile,
  parseSchedule,
  ROUTINE_INSTRUCTIONS_MAX_LENGTH,
  ROUTINE_TEMPLATES,
  type Routine,
  type RoutineListResponse,
  type RoutineRun,
  type RoutineRunResponse,
  renderRoutineFile,
  routineIdForPath,
  routineNameFromPath,
  routineNameProblem,
  routinePathForName,
  type ServerEvent,
  today,
  toISODate,
  updateRoutineFile,
  type VaultChange,
} from "@ddl/core";
import { HttpError } from "../errors";
import { type MockAgent, MockNotFoundError, type MockRoutineRunEnd } from "./mock-agent";
import type { MockVault } from "./mock-vault";

/** The daemon's `EXTRA_RUNS_PER_DAY`: runs beyond the schedule (Run now) allowed each day. */
export const MOCK_EXTRA_RUNS_PER_DAY = 5;

export interface MockRoutinesHost {
  vault: MockVault;
  agent: MockAgent;
  emit(event: ServerEvent): void;
  /** Announces a routine file the daemon itself wrote. */
  vaultChanged(changes: VaultChange[]): void;
  agentEnabled(): boolean;
}

interface RoutineState {
  /** Run thread ids, newest first. */
  runs: string[];
  lastRun?: RoutineRun;
  extraRuns?: { date: string; count: number };
}

function failure(status: number, error: string, message: string): HttpError {
  return new HttpError(status, message, { error, message });
}

/**
 * The daemon's routine library and scheduler, in the browser: routines are the vault's
 * `Routines/*.md` files, with runs, the extra-runs budget and notifications kept in memory. Only
 * Run now starts runs: schedules don't fire here.
 */
export class MockRoutines {
  private readonly host: MockRoutinesHost;
  private readonly states = new Map<string, RoutineState>();

  constructor(host: MockRoutinesHost) {
    this.host = host;
  }

  listResponse(): RoutineListResponse {
    return { routines: this.list(), templates: [...ROUTINE_TEMPLATES] };
  }

  list(): Routine[] {
    return this.host.vault
      .paths()
      .filter(isRoutinePath)
      .map((path) => this.summarize(path))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): Routine {
    const path = this.pathOf(id);
    if (!path) throw new MockNotFoundError("Routine");
    return this.summarize(path);
  }

  create(request: CreateRoutineRequest): Routine {
    const problem =
      routineNameProblem(request.name) ??
      (() => {
        const parsed = parseSchedule(request.schedule);
        return parsed.ok ? null : parsed.error;
      })() ??
      (request.instructions.trim() === "" ? "Say what the routine should do." : null) ??
      (request.instructions.trim().length > ROUTINE_INSTRUCTIONS_MAX_LENGTH
        ? `Keep the instructions under ${ROUTINE_INSTRUCTIONS_MAX_LENGTH} characters.`
        : null);
    if (problem) throw failure(400, "invalid_request", problem);
    const path = routinePathForName(request.name);
    if (this.host.vault.has(path)) {
      throw failure(409, "conflict", `A routine named “${request.name}” already exists.`);
    }
    const note = this.host.vault.write(path, renderRoutineFile(request));
    this.host.vaultChanged([{ path, kind: "created", version: note.version }]);
    this.changed();
    return this.summarize(path);
  }

  setPaused(id: string, paused: boolean): Routine {
    const path = this.pathOf(id);
    const content = path ? this.host.vault.get(path)?.content : undefined;
    if (!path || content === undefined) throw new MockNotFoundError("Routine");
    const note = this.host.vault.write(path, updateRoutineFile(content, { paused }));
    this.host.vaultChanged([{ path, kind: "modified", version: note.version }]);
    this.changed();
    return this.summarize(path);
  }

  run(id: string): RoutineRunResponse {
    const path = this.pathOf(id);
    if (!path) throw new MockNotFoundError("Routine");
    if (!this.host.agentEnabled()) {
      throw failure(503, "agent_unavailable", "The agent is paused: switch it on to run routines.");
    }
    const routine = this.summarize(path);
    if (routine.error) {
      throw failure(409, "conflict", `“${routine.name}” can't run: ${routine.error}`);
    }
    if (routine.lastRun && this.isRunning(routine.lastRun)) {
      throw failure(409, "conflict", `“${routine.name}” is running right now.`);
    }
    if (routine.extraRunsLeft === 0) {
      throw failure(
        409,
        "conflict",
        `“${routine.name}” already ran the most extra times allowed today; it runs again on its schedule.`,
      );
    }
    const threadId = this.runNow(path);
    return { routine: this.summarize(path), threadId };
  }

  /** Notes changed in the vault: routines follow their files. */
  observe(paths: readonly string[]): void {
    if (paths.some(isRoutinePath)) this.changed();
  }

  private runNow(path: string): string {
    const id = routineIdForPath(path);
    const state = this.stateOf(id);
    const file = parseRoutineFile(this.host.vault.get(path)?.content ?? "");
    const date = toISODate(today());
    const threadId = this.host.agent.startRoutineRun(
      {
        routineId: id,
        name: routineNameFromPath(path),
        path,
        instructions: file.instructions,
        note: "Run now",
        changed: state.runs.length === 0,
      },
      (end) => this.finished(path, threadId, end),
    );
    state.runs.unshift(threadId);
    state.lastRun = { threadId, trigger: "manual", status: "triaging", startedAt: Date.now() };
    const used = state.extraRuns?.date === date ? state.extraRuns.count : 0;
    state.extraRuns = { date, count: used + 1 };
    this.changed();
    return threadId;
  }

  private finished(path: string, threadId: string, end: MockRoutineRunEnd): void {
    const id = routineIdForPath(path);
    const state = this.stateOf(id);
    if (state.lastRun?.threadId !== threadId) return;
    const changed = end.status === "done" ? end.summary !== "Nothing new" : undefined;
    state.lastRun = {
      ...state.lastRun,
      status: end.status,
      finishedAt: Date.now(),
      ...(end.summary ? { summary: end.summary } : {}),
      ...(changed === undefined ? {} : { changed }),
    };
    this.changed();
    const { notify } = parseRoutineFile(this.host.vault.get(path)?.content ?? "");
    const tell =
      notify !== "never" &&
      (end.status === "failed" ||
        (end.status === "done" && (notify === "always" || changed !== false)));
    if (!tell) return;
    const result = end.result.split("\n").filter(Boolean).slice(0, 2).join(" ");
    this.host.emit({
      type: "routine.notification",
      notification: {
        routineId: id,
        title: routineNameFromPath(path),
        body: end.status === "failed" ? `Failed: ${end.summary || "the run stopped"}` : result,
        threadId,
        status: end.status,
        at: Date.now(),
      },
    });
  }

  private summarize(path: string): Routine {
    const id = routineIdForPath(path);
    const file = parseRoutineFile(this.host.vault.get(path)?.content ?? "");
    const state = this.states.get(id);
    const error = file.problems[0];
    const next =
      file.parsedSchedule && !file.paused && !error
        ? nextRunAfter(file.parsedSchedule, Date.now())
        : null;
    const lastRun = state?.lastRun ? this.live(state.lastRun) : undefined;
    const used = state?.extraRuns?.date === toISODate(today()) ? state.extraRuns.count : 0;
    return {
      id,
      path,
      name: routineNameFromPath(path),
      schedule: file.schedule ?? "",
      ...(file.parsedSchedule ? { scheduleText: describeSchedule(file.parsedSchedule) } : {}),
      notify: file.notify,
      uses: [...file.uses],
      paused: file.paused,
      instructions: file.instructions,
      ...(error ? { error } : {}),
      ...(next === null ? {} : { nextRunAt: next }),
      ...(lastRun ? { lastRun } : {}),
      runCount: state?.runs.length ?? 0,
      extraRunsLeft: Math.max(0, MOCK_EXTRA_RUNS_PER_DAY - used),
    };
  }

  /** A run still going reports its thread's current status. */
  private live(run: RoutineRun): RoutineRun {
    if (run.finishedAt !== undefined) return run;
    return { ...run, status: this.host.agent.threadStatus(run.threadId) ?? run.status };
  }

  private isRunning(run: RoutineRun): boolean {
    return run.finishedAt === undefined;
  }

  private pathOf(id: string): string | undefined {
    return this.host.vault
      .paths()
      .find((path) => isRoutinePath(path) && routineIdForPath(path) === id);
  }

  private stateOf(id: string): RoutineState {
    let state = this.states.get(id);
    if (!state) {
      state = { runs: [] };
      this.states.set(id, state);
    }
    return state;
  }

  private changed(): void {
    this.host.emit({ type: "routines.changed", routines: this.list() });
  }
}
