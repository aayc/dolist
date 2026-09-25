import type { CreateRoutineRequest, Routine } from "@ddl/core";
import type { DaemonClient } from "../api/client";
import { errorMessage } from "../api/errors";
import { type Notice, runProblem } from "../features/routines/routine-errors";
import { mergeThreadSummaries } from "../state/agent-reducer";
import { updateAgentState } from "../state/agent-store";
import {
  applyRoutine,
  applyRoutineList,
  findRoutine,
  updateRoutines,
  useRoutinesStore,
} from "../state/routines-store";
import { toast } from "../state/toast-store";

export type RunResult = { ok: true; threadId: string } | { ok: false; problem: Notice };
/** A failed create keeps the daemon's error: the dialog shows it under the field it's about. */
export type CreateResult = { ok: true; routine: Routine } | { ok: false; error: unknown };

export interface RoutineNavigator {
  openNote(path: string, options?: { focus?: boolean }): Promise<boolean>;
}

/** Routine-side user actions: the list, a routine's runs, Run now, Pause/Resume, create, edit. */
export class RoutineActions {
  private readonly client: DaemonClient;
  private navigator: RoutineNavigator | null = null;
  private loading: Promise<void> | null = null;
  /** Routines whose runs were fetched (fetched again after a reconnect). */
  private readonly runLists = new Set<string>();

  constructor(client: DaemonClient) {
    this.client = client;
  }

  attach(navigator: RoutineNavigator): void {
    this.navigator = navigator;
  }

  /** Loads the list and the templates once; `routines.changed` keeps the list current. */
  ensureLoaded(): Promise<void> {
    const { status, templatesLoaded } = useRoutinesStore.getState();
    if (status === "loaded" && templatesLoaded) return Promise.resolve();
    return this.load();
  }

  load(): Promise<void> {
    if (this.loading) return this.loading;
    if (useRoutinesStore.getState().status !== "loaded") {
      updateRoutines((s) => ({ ...s, status: "loading", error: null }));
    }
    this.loading = this.client
      .listRoutines()
      .then(
        (list) => updateRoutines((s) => applyRoutineList(s, list)),
        (error: unknown) =>
          updateRoutines((s) =>
            s.status === "loaded" ? s : { ...s, status: "error", error: errorMessage(error) },
          ),
      )
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  /** Fetches a routine's runs; thread events keep them current afterwards. */
  async loadRuns(routineId: string): Promise<void> {
    this.runLists.add(routineId);
    try {
      const { threads } = await this.client.listThreads({ routineId });
      updateAgentState((s) => mergeThreadSummaries(s, threads));
    } catch {
      // The startup thread list has them too; a reconnect tries again.
    }
  }

  async runNow(routine: Pick<Routine, "id">): Promise<RunResult> {
    try {
      const { routine: updated, threadId } = await this.client.runRoutine(routine.id);
      updateRoutines((s) => applyRoutine(s, updated));
      return { ok: true, threadId };
    } catch (error) {
      return { ok: false, problem: runProblem(error) };
    }
  }

  /** Shows the new state at once; a failure puts it back and says why. */
  async setPaused(routine: Routine, paused: boolean): Promise<void> {
    const previous = findRoutine(useRoutinesStore.getState(), routine.id) ?? routine;
    const { nextRunAt: _next, ...unscheduled } = previous;
    updateRoutines((s) =>
      applyRoutine(s, paused ? { ...unscheduled, paused } : { ...previous, paused }),
    );
    try {
      const { routine: updated } = await (paused
        ? this.client.pauseRoutine(routine.id)
        : this.client.resumeRoutine(routine.id));
      updateRoutines((s) => applyRoutine(s, updated));
    } catch (error) {
      updateRoutines((s) => applyRoutine(s, previous));
      toast({
        kind: "error",
        title: `Couldn't ${paused ? "pause" : "resume"} “${routine.name}”`,
        body: errorMessage(error),
      });
    }
  }

  async create(request: CreateRoutineRequest): Promise<CreateResult> {
    try {
      const { routine } = await this.client.createRoutine(request);
      updateRoutines((s) => applyRoutine(s, routine));
      return { ok: true, routine };
    } catch (error) {
      return { ok: false, error };
    }
  }

  /** Opens the routine's file (`Routines/<name>.md`) in the editor. */
  edit(routine: Pick<Routine, "path">): Promise<boolean> {
    return this.navigator?.openNote(routine.path, { focus: true }) ?? Promise.resolve(false);
  }

  async resync(): Promise<void> {
    if (useRoutinesStore.getState().status === "idle") return;
    await Promise.allSettled([this.load(), ...[...this.runLists].map((id) => this.loadRuns(id))]);
  }
}
