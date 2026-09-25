import {
  type CreateRoutineRequest,
  ROUTINE_INSTRUCTIONS_MAX_LENGTH,
  routineNameProblem,
} from "@ddl/core";
import { errorMessage, HttpError } from "../../api/errors";
import { reason } from "./routine-errors";

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
