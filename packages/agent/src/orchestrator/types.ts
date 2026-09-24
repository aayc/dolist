import type { TaskChangeKind, TrackedTask } from "@ddl/core";
import type { Capability } from "../execution/types";

export type TaskEventKind = "added" | "updated" | "completed" | "reopened" | "removed";

/** A settled change to a to-do item, produced by the TaskWatcher after the settle delay. */
export interface TaskEvent {
  kind: TaskEventKind;
  notePath: string;
  /** ISO date of the daily note. */
  date: string | null;
  task: TrackedTask;
  previous?: TrackedTask;
  changes?: TaskChangeKind[];
  at: number;
}

/** What the orchestrator asks a subagent to do. */
export interface SubagentSpec {
  taskId: string;
  /** One-sentence goal, e.g. "Find 3 dentist appointments next week near the user's home". */
  goal: string;
  /** Extra instructions/constraints from the orchestrator. */
  instructions?: string;
  capabilities: Capability[];
}
