import { TOOL } from "../../tools/contracts";
import type { RuleHit } from "./types";
import { info } from "./types";

/**
 * The orchestrator's routine tools. A routine is work the agent does later on its own, so creating
 * one, or changing what or when it runs, is a medium-risk change the approval policy decides on
 * like any other (its runs' actions still pass the gate one by one). Pausing only does less, and a
 * run started now goes through the gate step by step.
 */
export const ROUTINE_CREATE = info(
  "routines.create",
  "file_write",
  "require_approval",
  "medium",
  "Creates a routine: work the agent will do on its own, on a schedule",
);
export const ROUTINE_CHANGE = info(
  "routines.change",
  "file_write",
  "require_approval",
  "medium",
  "Changes what a routine does or when it runs, or resumes it",
);
export const ROUTINE_FILE_EDIT = info(
  "routines.file-edit",
  "file_write",
  "require_approval",
  "medium",
  "Edits a routine's file (what the agent does on its own, and when)",
);
export const ROUTINE_PAUSE = info(
  "routines.pause",
  "file_write",
  "allow",
  "low",
  "Pauses a routine",
);
export const ROUTINE_RUN = info(
  "routines.run",
  "compute",
  "allow",
  "low",
  "Runs a routine now (each of its actions is checked as usual)",
);
export const ROUTINE_READ = info(
  "routines.read",
  "read",
  "allow",
  "low",
  "Lists routines and their last results",
);

export const ROUTINE_RULES = [
  ROUTINE_CREATE,
  ROUTINE_CHANGE,
  ROUTINE_FILE_EDIT,
  ROUTINE_PAUSE,
  ROUTINE_RUN,
  ROUTINE_READ,
] as const;

export const ROUTINE_TOOLS: ReadonlySet<string> = new Set([
  TOOL.createRoutine,
  TOOL.updateRoutine,
  TOOL.runRoutine,
  TOOL.listRoutines,
]);

/** A vault path inside the routines folder (any case: file systems may not care). */
export function isRoutineFolderPath(path: string): boolean {
  return /^\/?routines\//i.test(path.replace(/\\/g, "/").replace(/^\.\//, ""));
}

export function routineToolHits(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
): RuleHit[] {
  const name = typeof input.name === "string" ? input.name.slice(0, 80) : "";
  switch (toolName) {
    case TOOL.createRoutine:
      return [{ rule: ROUTINE_CREATE, evidence: `“${name}”` }];
    case TOOL.updateRoutine: {
      const changes = ["schedule", "instructions", "notify", "uses"].filter(
        (key) => input[key] !== undefined && input[key] !== null,
      );
      if (changes.length === 0 && input.paused === true) {
        return [{ rule: ROUTINE_PAUSE, evidence: `“${name}”` }];
      }
      return [
        {
          rule: ROUTINE_CHANGE,
          evidence: `“${name}”: ${changes.length > 0 ? changes.join(", ") : "resume"}`,
        },
      ];
    }
    case TOOL.runRoutine:
      return [{ rule: ROUTINE_RUN, evidence: `“${name}”` }];
    default:
      return [{ rule: ROUTINE_READ, evidence: toolName }];
  }
}
