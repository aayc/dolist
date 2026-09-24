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

/**
 * A settled change to the rest of a note (headings, paragraphs, plain bullets): the user's lines
 * that are new or edited since the last such event. The agent's own lines never count.
 */
export interface NoteEvent {
  notePath: string;
  date: string | null;
  /** 0-based lines, in note order. */
  lines: Array<{ line: number; text: string }>;
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
