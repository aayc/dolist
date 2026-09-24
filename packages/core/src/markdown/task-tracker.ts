import { createId } from "../ids";
import { diceSimilarity, isPrefixExtension, normalizeText } from "../text";
import type { ParsedTask, TaskStatus } from "./tasks";

/**
 * A task with a stable identity. Identity survives edits, reordering and status changes so that
 * agent threads stay attached to "the same" to-do item while the user rewrites it.
 */
export interface TrackedTask {
  id: string;
  text: string;
  status: TaskStatus;
  line: number;
  depth: number;
  parentId: string | null;
  notes: string[];
  /** Epoch ms when the task was first observed. */
  firstSeenAt: number;
  /** Epoch ms of the last text/notes/status change. */
  updatedAt: number;
}

export type TaskChangeKind = "text" | "notes";

export interface TaskDiff {
  added: TrackedTask[];
  /** Text and/or notes changed. */
  updated: Array<{ task: TrackedTask; previous: TrackedTask; changes: TaskChangeKind[] }>;
  statusChanged: Array<{ task: TrackedTask; previous: TrackedTask }>;
  removed: TrackedTask[];
}

export interface TrackOptions {
  now?: number;
  idFactory?: () => string;
  /** Minimum fuzzy similarity (0..1) to treat an edited line as the same task. Default 0.5. */
  similarityThreshold?: number;
}

export function isEmptyDiff(diff: TaskDiff): boolean {
  return (
    diff.added.length === 0 &&
    diff.updated.length === 0 &&
    diff.statusChanged.length === 0 &&
    diff.removed.length === 0
  );
}

function sameNotes(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((n, i) => n === b[i]);
}

/**
 * Matches freshly parsed tasks against previously tracked ones and returns the new tracked list
 * plus a diff. Matching passes, in order:
 *  1. identical normalized text (nearest line wins among duplicates);
 *  2. fuzzy: prefix-extension (still typing) or Dice similarity ≥ threshold, with a small
 *     line-distance penalty, assigned greedily by best score;
 *  3. same line index with weak similarity (≥ 0.3) — an in-place rewrite.
 * Unmatched parsed tasks are `added`; unmatched previous tasks are `removed`.
 */
export function trackTasks(
  previous: readonly TrackedTask[],
  parsed: readonly ParsedTask[],
  options: TrackOptions = {},
): { tasks: TrackedTask[]; diff: TaskDiff } {
  const now = options.now ?? Date.now();
  const idFactory = options.idFactory ?? (() => createId("tsk", 10));
  const threshold = options.similarityThreshold ?? 0.5;

  const matchOf = new Array<number>(parsed.length).fill(-1);
  const usedPrev = new Array<boolean>(previous.length).fill(false);

  // Pass 1: exact normalized text.
  const byText = new Map<string, number[]>();
  previous.forEach((t, i) => {
    const key = normalizeText(t.text);
    const list = byText.get(key);
    if (list) list.push(i);
    else byText.set(key, [i]);
  });
  parsed.forEach((p, pi) => {
    const candidates = byText.get(normalizeText(p.text));
    if (!candidates) return;
    let best = -1;
    for (const ci of candidates) {
      if (usedPrev[ci]) continue;
      if (
        best === -1 ||
        Math.abs(previous[ci]!.line - p.line) < Math.abs(previous[best]!.line - p.line)
      ) {
        best = ci;
      }
    }
    if (best !== -1) {
      usedPrev[best] = true;
      matchOf[pi] = best;
    }
  });

  // Pass 2: fuzzy matching among the leftovers.
  const pairs: Array<{ pi: number; ci: number; score: number }> = [];
  parsed.forEach((p, pi) => {
    if (matchOf[pi] !== -1) return;
    previous.forEach((t, ci) => {
      if (usedPrev[ci]) return;
      let sim = diceSimilarity(p.text, t.text);
      if (isPrefixExtension(p.text, t.text)) sim = Math.max(sim, 0.9);
      if (sim < threshold) return;
      const distancePenalty = Math.min(Math.abs(t.line - p.line), 20) * 0.01;
      pairs.push({ pi, ci, score: sim - distancePenalty });
    });
  });
  pairs.sort((a, b) => b.score - a.score);
  for (const { pi, ci } of pairs) {
    if (matchOf[pi] !== -1 || usedPrev[ci]) continue;
    matchOf[pi] = ci;
    usedPrev[ci] = true;
  }

  // Pass 3: in-place rewrite on the same line.
  parsed.forEach((p, pi) => {
    if (matchOf[pi] !== -1) return;
    const ci = previous.findIndex((t, i) => !usedPrev[i] && t.line === p.line);
    if (ci !== -1 && diceSimilarity(p.text, previous[ci]!.text) >= 0.3) {
      matchOf[pi] = ci;
      usedPrev[ci] = true;
    }
  });

  const diff: TaskDiff = { added: [], updated: [], statusChanged: [], removed: [] };
  const idByLine = new Map<number, string>();
  const tasks: TrackedTask[] = parsed.map((p, pi) => {
    const prevIndex = matchOf[pi]!;
    const prev = prevIndex === -1 ? undefined : previous[prevIndex];
    const id = prev?.id ?? idFactory();
    idByLine.set(p.line, id);
    const task: TrackedTask = {
      id,
      text: p.text,
      status: p.status,
      line: p.line,
      depth: p.depth,
      parentId: null, // resolved below once all ids are known
      notes: [...p.notes],
      firstSeenAt: prev?.firstSeenAt ?? now,
      updatedAt: now,
    };
    if (!prev) {
      diff.added.push(task);
      return task;
    }
    const changes: TaskChangeKind[] = [];
    if (prev.text !== p.text) changes.push("text");
    if (!sameNotes(prev.notes, p.notes)) changes.push("notes");
    const statusChanged = prev.status !== p.status;
    if (changes.length > 0) diff.updated.push({ task, previous: prev, changes });
    if (statusChanged) diff.statusChanged.push({ task, previous: prev });
    if (changes.length === 0 && !statusChanged) task.updatedAt = prev.updatedAt;
    return task;
  });

  parsed.forEach((p, pi) => {
    tasks[pi]!.parentId = p.parentLine === null ? null : (idByLine.get(p.parentLine) ?? null);
  });
  previous.forEach((t, ci) => {
    if (!usedPrev[ci]) diff.removed.push(t);
  });

  return { tasks, diff };
}
