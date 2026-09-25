import {
  parseSchedule,
  ROUTINE_INSTRUCTIONS_MAX_LENGTH,
  ROUTINE_NOTIFY_VALUES,
  ROUTINE_USES,
  type RoutineFileInput,
  type RoutineFilePatch,
  type RoutineNotify,
  type RoutineUse,
  renderRoutineFile,
  routineNameProblem,
  routinePathForName,
  updateRoutineFile,
} from "@ddl/core";
import { ConflictError, type StorageProvider } from "@ddl/storage";
import { ToolInputError } from "../tools/input";

/** A routine the user or an agent described can't be written as asked (the message says why). */
export class RoutineInputError extends ToolInputError {
  constructor(message: string) {
    super(message);
    this.name = "RoutineInputError";
  }
}

export class UnknownRoutineError extends ToolInputError {
  constructor(what: string) {
    super(`There's no routine ${what}. Use list_routines to see them.`);
    this.name = "UnknownRoutineError";
  }
}

/** It can't happen right now (a run is going, the file changed, today's budget is used up). */
export class RoutineConflictError extends ToolInputError {
  constructor(message: string) {
    super(message);
    this.name = "RoutineConflictError";
  }
}

export interface NewRoutine extends RoutineFileInput {
  name: string;
}

function checkSchedule(schedule: string): void {
  const parsed = parseSchedule(schedule);
  if (!parsed.ok) throw new RoutineInputError(parsed.error);
}

function checkInstructions(instructions: string): void {
  const text = instructions.trim();
  if (text === "") throw new RoutineInputError("Say what the routine should do.");
  if (text.length > ROUTINE_INSTRUCTIONS_MAX_LENGTH) {
    throw new RoutineInputError(
      `Keep the instructions under ${ROUTINE_INSTRUCTIONS_MAX_LENGTH} characters.`,
    );
  }
}

function checkSettings(input: { notify?: RoutineNotify; uses?: readonly RoutineUse[] }): void {
  if (input.notify !== undefined && !ROUTINE_NOTIFY_VALUES.includes(input.notify)) {
    throw new RoutineInputError("notify must be always, when_changed or never.");
  }
  for (const use of input.uses ?? []) {
    if (!ROUTINE_USES.includes(use)) {
      throw new RoutineInputError(`“${use}” isn't a capability (${ROUTINE_USES.join(", ")}).`);
    }
  }
}

/** Writes `Routines/<name>.md` (never over an existing file) and returns its path. */
export async function writeNewRoutine(
  storage: StorageProvider,
  input: NewRoutine,
): Promise<string> {
  const problem = routineNameProblem(input.name);
  if (problem) throw new RoutineInputError(problem);
  checkSchedule(input.schedule);
  checkInstructions(input.instructions);
  checkSettings(input);
  const path = routinePathForName(input.name);
  try {
    await storage.write(path, renderRoutineFile(input), { ifMatch: null });
  } catch (error) {
    if (error instanceof ConflictError) {
      throw new RoutineConflictError(
        `A routine named “${input.name}” already exists. Pick another name, or change that one.`,
      );
    }
    throw error;
  }
  return path;
}

/** Changes settings or instructions of the routine file at `path`, keeping the rest as written. */
export async function patchRoutineFile(
  storage: StorageProvider,
  path: string,
  patch: RoutineFilePatch,
): Promise<void> {
  if (patch.schedule !== undefined) checkSchedule(patch.schedule);
  if (patch.instructions !== undefined) checkInstructions(patch.instructions);
  checkSettings(patch);
  for (let attempt = 0; attempt < 3; attempt++) {
    const file = await storage.read(path);
    if (!file) throw new UnknownRoutineError(`at ${path}`);
    const next = updateRoutineFile(file.content, patch);
    if (next === file.content) return;
    try {
      await storage.write(path, next, { ifMatch: file.version });
      return;
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
    }
  }
  throw new RoutineConflictError("The routine's file kept changing while it was being written.");
}
