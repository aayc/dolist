import type { Routine, RoutineListResponse, RoutineTemplate } from "@ddl/core";
import { create } from "zustand";

export interface RoutinesState {
  /** Sorted by name, like the daemon sends them. */
  routines: readonly Routine[];
  /** The starter routines "New routine" offers (only the list response carries them). */
  templates: readonly RoutineTemplate[];
  templatesLoaded: boolean;
  /** `loaded` once a list or a `routines.changed` event arrived. */
  status: "idle" | "loading" | "loaded" | "error";
  /** Why the list couldn't be loaded (while nothing was loaded yet). */
  error: string | null;
}

export const initialRoutinesState: RoutinesState = {
  routines: [],
  templates: [],
  templatesLoaded: false,
  status: "idle",
  error: null,
};

export function sortRoutines(routines: readonly Routine[]): Routine[] {
  return [...routines].sort((a, b) => a.name.localeCompare(b.name));
}

export function applyRoutineList(state: RoutinesState, list: RoutineListResponse): RoutinesState {
  return {
    ...state,
    routines: sortRoutines(list.routines),
    templates: list.templates,
    templatesLoaded: true,
    status: "loaded",
    error: null,
  };
}

/** `routines.changed` carries every routine: it replaces the list. */
export function applyRoutinesChanged(
  state: RoutinesState,
  routines: readonly Routine[],
): RoutinesState {
  return { ...state, routines: sortRoutines(routines), status: "loaded", error: null };
}

/** One routine as an action returned it (added if new, e.g. just created). */
export function applyRoutine(state: RoutinesState, routine: Routine): RoutinesState {
  const others = state.routines.filter((r) => r.id !== routine.id);
  return { ...state, routines: sortRoutines([...others, routine]) };
}

export function findRoutine(state: RoutinesState, id: string): Routine | undefined {
  return state.routines.find((routine) => routine.id === id);
}

export const useRoutinesStore = create<RoutinesState>(() => initialRoutinesState);

export function updateRoutines(update: (state: RoutinesState) => RoutinesState): void {
  const state = useRoutinesStore.getState();
  const next = update(state);
  if (next !== state) useRoutinesStore.setState(next, true);
}
