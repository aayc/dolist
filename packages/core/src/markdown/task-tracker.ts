import { createId } from "../ids";
import { normalizeText } from "../text";
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

/** Above this many candidate pairs, the fuzzy pass only compares tasks on nearby lines. */
const FUZZY_PAIR_BUDGET = 40_000;
const MIN_FUZZY_WINDOW = 20;
/** Duplicate groups bigger than this (parsed × previous) are aligned greedily, not optimally. */
const ALIGN_CELL_BUDGET = 250_000;
/** Weight of the displacement cost over the raw line distance used to break its ties. */
const TIE_SCALE = 1 << 20;

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
 *  1. identical normalized text. A text found once on each side is an anchor; duplicates are
 *     aligned in order, preferring the lines the anchors predict (so deleting, inserting or typing
 *     one of several identical tasks leaves the others' ids alone);
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
  const matchOf = matchTasks(previous, parsed, options.similarityThreshold ?? 0.5);

  const diff: TaskDiff = { added: [], updated: [], statusChanged: [], removed: [] };
  const usedPrev = new Array<boolean>(previous.length).fill(false);
  const idByLine = new Map<number, string>();
  const tasks: TrackedTask[] = parsed.map((p, pi) => {
    const prevIndex = matchOf[pi]!;
    const prev = prevIndex === -1 ? undefined : previous[prevIndex];
    if (prev) usedPrev[prevIndex] = true;
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

interface LineText {
  text: string;
  line: number;
}

/** For each parsed task, the index of the previous task it continues, or -1. */
function matchTasks(
  previous: readonly LineText[],
  parsed: readonly LineText[],
  threshold: number,
): number[] {
  const matchOf = new Array<number>(parsed.length).fill(-1);
  const usedPrev = new Array<boolean>(previous.length).fill(false);
  const link = (pi: number, ci: number) => {
    matchOf[pi] = ci;
    usedPrev[ci] = true;
  };
  const prevText = previous.map((t) => new TextFeatures(t.text));
  const nextText = parsed.map((p) => new TextFeatures(p.text));

  // Pass 1: identical normalized text.
  const groups = new Map<string, { prev: number[]; next: number[] }>();
  const groupOf = (key: string) => {
    let group = groups.get(key);
    if (!group) {
      group = { prev: [], next: [] };
      groups.set(key, group);
    }
    return group;
  };
  for (const [ci, f] of prevText.entries()) groupOf(f.normalized).prev.push(ci);
  for (const [pi, f] of nextText.entries()) groupOf(f.normalized).next.push(pi);
  const anchors: Array<{ line: number; shift: number }> = [];
  for (const { prev, next } of groups.values()) {
    if (prev.length !== 1 || next.length !== 1) continue;
    link(next[0]!, prev[0]!);
    const line = parsed[next[0]!]!.line;
    anchors.push({ line, shift: line - previous[prev[0]!]!.line });
  }
  anchors.sort((a, b) => a.line - b.line);
  /** Where a parsed line sat before the edit, judging by the nearest anchor (above first). */
  const expectedLine = (line: number) => {
    let lo = 0;
    let hi = anchors.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (anchors[mid]!.line <= line) lo = mid + 1;
      else hi = mid;
    }
    const anchor = anchors[lo - 1] ?? anchors[lo];
    return line - (anchor?.shift ?? 0);
  };
  const expected = new Float64Array(parsed.length).fill(Number.NaN);
  const duplicateCost = (pi: number, ci: number) => {
    const p = parsed[pi]!.line;
    const c = previous[ci]!.line;
    if (Number.isNaN(expected[pi]!)) expected[pi] = expectedLine(p);
    return Math.abs(expected[pi]! - c) * TIE_SCALE + Math.min(Math.abs(p - c), TIE_SCALE - 1);
  };
  for (const { prev, next } of groups.values()) {
    if (prev.length === 0 || next.length === 0 || (prev.length === 1 && next.length === 1)) {
      continue;
    }
    const byLine = (list: readonly LineText[]) => (a: number, b: number) =>
      list[a]!.line - list[b]!.line || a - b;
    alignDuplicates(
      [...next].sort(byLine(parsed)),
      [...prev].sort(byLine(previous)),
      duplicateCost,
      link,
    );
  }

  // Pass 2: fuzzy matching among the leftovers.
  const openNext = parsed.flatMap((_, pi) => (matchOf[pi] === -1 ? [pi] : []));
  const openPrev = previous.flatMap((_, ci) => (usedPrev[ci] ? [] : [ci]));
  const pairs: Array<{ pi: number; ci: number; score: number }> = [];
  const consider = (pi: number, ci: number) => {
    let sim = nextText[pi]!.similarity(prevText[ci]!);
    if (nextText[pi]!.extends(prevText[ci]!)) sim = Math.max(sim, 0.9);
    if (sim < threshold) return;
    const distancePenalty = Math.min(Math.abs(previous[ci]!.line - parsed[pi]!.line), 20) * 0.01;
    pairs.push({ pi, ci, score: sim - distancePenalty });
  };
  if (openNext.length * openPrev.length <= FUZZY_PAIR_BUDGET) {
    for (const pi of openNext) for (const ci of openPrev) consider(pi, ci);
  } else {
    // A mass rewrite: only nearby lines can plausibly be the same task, and comparing everything
    // with everything would block the event loop for seconds on a long note.
    const window = Math.max(
      MIN_FUZZY_WINDOW,
      Math.floor(FUZZY_PAIR_BUDGET / (2 * openNext.length)),
    );
    const sorted = [...openPrev].sort((a, b) => previous[a]!.line - previous[b]!.line || a - b);
    const lines = sorted.map((ci) => previous[ci]!.line);
    for (const pi of openNext) {
      const center = expectedLine(parsed[pi]!.line);
      for (let k = lowerBound(lines, center - window); k < sorted.length; k++) {
        if (lines[k]! > center + window) break;
        consider(pi, sorted[k]!);
      }
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  for (const { pi, ci } of pairs) {
    if (matchOf[pi] !== -1 || usedPrev[ci]) continue;
    link(pi, ci);
  }

  // Pass 3: in-place rewrite on the same line.
  const openByLine = new Map<number, number[]>();
  previous.forEach((t, ci) => {
    if (usedPrev[ci]) return;
    const list = openByLine.get(t.line);
    if (list) list.push(ci);
    else openByLine.set(t.line, [ci]);
  });
  parsed.forEach((p, pi) => {
    if (matchOf[pi] !== -1) return;
    const ci = openByLine.get(p.line)?.find((i) => !usedPrev[i]);
    if (ci !== undefined && nextText[pi]!.similarity(prevText[ci]!) >= 0.3) link(pi, ci);
  });

  return matchOf;
}

/**
 * Pairs up tasks that share one text. Both lists are sorted by line; every task of the shorter
 * list is matched, in order, to the task of the longer list that minimizes the total cost.
 */
function alignDuplicates(
  next: readonly number[],
  prev: readonly number[],
  cost: (pi: number, ci: number) => number,
  link: (pi: number, ci: number) => void,
): void {
  const nextIsLong = next.length >= prev.length;
  const long = nextIsLong ? next : prev;
  const short = nextIsLong ? prev : next;
  const pairCost = (l: number, s: number) => (nextIsLong ? cost(l, s) : cost(s, l));
  const pair = (l: number, s: number) => (nextIsLong ? link(l, s) : link(s, l));

  if (long.length * short.length > ALIGN_CELL_BUDGET) {
    const taken = new Array<boolean>(long.length).fill(false);
    for (const s of short) {
      let best = -1;
      for (let i = 0; i < long.length; i++) {
        if (!taken[i] && (best === -1 || pairCost(long[i]!, s) < pairCost(long[best]!, s))) {
          best = i;
        }
      }
      taken[best] = true;
      pair(long[best]!, s);
    }
    return;
  }

  // best[i][j]: cheapest way to match short[0..j) to an increasing subsequence of long[0..i).
  const cols = short.length + 1;
  const best = new Float64Array((long.length + 1) * cols).fill(Number.POSITIVE_INFINITY);
  const took = new Uint8Array((long.length + 1) * cols);
  for (let i = 0; i <= long.length; i++) best[i * cols] = 0;
  for (let i = 1; i <= long.length; i++) {
    for (let j = 1; j <= Math.min(i, short.length); j++) {
      const skip = best[(i - 1) * cols + j]!;
      const take = best[(i - 1) * cols + j - 1]! + pairCost(long[i - 1]!, short[j - 1]!);
      // Ties keep the earlier task of the longer list, like a nearest-line scan would.
      if (take < skip) {
        best[i * cols + j] = take;
        took[i * cols + j] = 1;
      } else {
        best[i * cols + j] = skip;
      }
    }
  }
  for (let i = long.length, j = short.length; j > 0; i--) {
    if (took[i * cols + j]) {
      pair(long[i - 1]!, short[j - 1]!);
      j--;
    }
  }
}

function lowerBound(sorted: readonly number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** A task text, normalized once, with lazily built bigram counts for Dice similarity. */
class TextFeatures {
  readonly normalized: string;
  private counts: Map<string, number> | undefined;

  constructor(text: string) {
    this.normalized = normalizeText(text);
  }

  /** Same value as `diceSimilarity` on the original texts. */
  similarity(other: TextFeatures): number {
    const x = this.normalized;
    const y = other.normalized;
    if (x === y) return 1;
    if (x.length < 2 || y.length < 2) return 0;
    const [small, large] =
      x.length <= y.length ? [this.bigrams(), other.bigrams()] : [other.bigrams(), this.bigrams()];
    let overlap = 0;
    for (const [bigram, count] of small) overlap += Math.min(count, large.get(bigram) ?? 0);
    return (2 * overlap) / (x.length - 1 + (y.length - 1));
  }

  /** Same value as `isPrefixExtension` on the original texts. */
  extends(other: TextFeatures, minLength = 3): boolean {
    const x = this.normalized;
    const y = other.normalized;
    if (x.length < minLength || y.length < minLength) return false;
    return x.startsWith(y) || y.startsWith(x);
  }

  private bigrams(): Map<string, number> {
    if (!this.counts) {
      this.counts = new Map();
      const s = this.normalized;
      for (let i = 0; i < s.length - 1; i++) {
        const bigram = s.slice(i, i + 2);
        this.counts.set(bigram, (this.counts.get(bigram) ?? 0) + 1);
      }
    }
    return this.counts;
  }
}
