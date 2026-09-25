import {
  type CreateRoutineRequest,
  ROUTINE_INSTRUCTIONS_MAX_LENGTH,
  routineNameProblem,
} from "@ddl/core";
import { errorMessage, HttpError, NetworkError } from "../../api/errors";

/** What went wrong, for a notice: a short title and the daemon's reason. */
export interface Notice {
  title: string;
  body: string;
}

function reason(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message.trim() : "";
  return message || fallback;
}

/**
 * Why Run now didn't start a run. The daemon's message says which case it is (a run is going,
 * the routine has a problem, today's extra runs are used up; the agent is off or can't run here).
 */
export function runProblem(error: unknown): Notice {
  if (error instanceof HttpError) {
    switch (error.status) {
      case 409:
        return {
          title: "It can't run right now",
          body: reason(error, "A run is going, or today's extra runs are used up."),
        };
      case 503:
        return {
          title: "The agent can't run here",
          body: reason(error, "The agent isn't running on this device."),
        };
      case 404:
        return { title: "This routine is gone", body: "Its file was moved or deleted." };
    }
  }
  if (error instanceof NetworkError) {
    return { title: "Couldn't reach Daily Do List", body: reason(error, "The daemon is offline.") };
  }
  return { title: "Couldn't start the run", body: errorMessage(error) };
}

export type RoutineField = "name" | "schedule" | "instructions";

/** Where a failed "create" goes in the form: under a field, or above the buttons (`null`). */
export interface CreateProblem {
  field: RoutineField | null;
  message: string;
}

/**
 * The daemon answers 400 with one message for whichever field it rejected: the name and the
 * instructions are checked here the same way, so what's left is the schedule.
 */
export function createProblem(error: unknown, request: CreateRoutineRequest): CreateProblem {
  if (error instanceof HttpError && error.status === 409) {
    return { field: "name", message: reason(error, `“${request.name}” already exists.`) };
  }
  if (error instanceof HttpError && error.status === 400) {
    const instructions = request.instructions.trim();
    const field: RoutineField = routineNameProblem(request.name)
      ? "name"
      : instructions === "" || instructions.length > ROUTINE_INSTRUCTIONS_MAX_LENGTH
        ? "instructions"
        : "schedule";
    return { field, message: reason(error, "The daemon couldn't read this.") };
  }
  return { field: null, message: errorMessage(error) };
}
