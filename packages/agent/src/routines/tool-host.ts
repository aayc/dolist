import type { Routine } from "@ddl/core";
import type { RoutineToolHost } from "../tools/routines";
import type { RoutineLibrary } from "./library";
import type { RoutineScheduler } from "./scheduler";

export interface RoutineHostOptions {
  library: RoutineLibrary;
  scheduler: RoutineScheduler;
  /** A routine file was written (the scheduler plans it right away). */
  onChanged: () => void;
}

const WHEN = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function when(ms: number): string {
  return WHEN.format(new Date(ms));
}

function describe(routine: Routine): string {
  const schedule = routine.scheduleText ?? routine.schedule;
  const parts = [`“${routine.name}”: ${schedule}`];
  if (routine.error) parts.push(`can't run: ${routine.error}`);
  else if (routine.paused) parts.push("paused");
  else if (routine.nextRunAt !== undefined) parts.push(`next run ${when(routine.nextRunAt)}`);
  parts.push(`notify ${routine.notify}`);
  if (routine.uses.length > 0) parts.push(`uses ${routine.uses.join(", ")}`);
  const last = routine.lastRun;
  if (last) {
    const summary = last.summary ? ` — ${last.summary}` : "";
    parts.push(`last run ${when(last.startedAt)}, ${last.status}${summary}`);
  }
  return parts.join(" · ");
}

/** The orchestrator's routine tools, on top of the routine library and the scheduler. */
export function createRoutineHost(options: RoutineHostOptions): RoutineToolHost {
  const { library, scheduler, onChanged } = options;
  return {
    async createRoutine(input) {
      const routine = await library.create(input);
      onChanged();
      const fresh = library.get(routine.id) ?? routine;
      return `Created routine ${describe(fresh)}. It's the file ${fresh.path}; each run reports in its own thread under Routines.`;
    },
    async updateRoutine(input) {
      const definition = library.resolve(input.name);
      const { name: _name, ...patch } = input;
      const routine = await library.update(definition.id, patch);
      onChanged();
      return `Updated routine ${describe(library.get(routine.id) ?? routine)}.`;
    },
    async runRoutine(input) {
      const { routineId } = scheduler.runNow(input.name);
      const routine = library.get(routineId);
      const left = routine ? ` (${routine.extraRunsLeft} more extra runs today)` : "";
      return `Started a run of “${routine?.name ?? input.name}”${left}; it reports in its own thread under Routines.`;
    },
    async listRoutines() {
      const routines = library.list();
      if (routines.length === 0) return "No routines yet (the Routines/ folder is empty).";
      return routines.map((routine) => `- ${describe(routine)}`).join("\n");
    },
  };
}
