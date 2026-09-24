import { type TrackedTask, trackTasks } from "./task-tracker";
import { type ParsedTask, parseTasks } from "./tasks";

/** Minimal reference to a server-tracked task, enough to re-find it in an edited document. */
export interface TaskAnchor {
  taskId: string;
  text: string;
  line: number;
}

/**
 * Re-resolves server task anchors against the current (possibly locally edited) document using the
 * same identity algorithm as the daemon. Returns taskId → 0-based line for every anchor found.
 */
export function resolveTaskAnchors(
  doc: string | readonly ParsedTask[],
  anchors: readonly TaskAnchor[],
): Map<string, number> {
  const parsed = typeof doc === "string" ? parseTasks(doc) : doc;
  const previous: TrackedTask[] = anchors.map((a) => ({
    id: a.taskId,
    text: a.text,
    status: "open",
    line: a.line,
    depth: 0,
    parentId: null,
    notes: [],
    firstSeenAt: 0,
    updatedAt: 0,
  }));
  const anchorIds = new Set(anchors.map((a) => a.taskId));
  const { tasks } = trackTasks(previous, parsed, { idFactory: () => "" });
  const out = new Map<string, number>();
  for (const t of tasks) if (t.id && anchorIds.has(t.id)) out.set(t.id, t.line);
  return out;
}
