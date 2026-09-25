/**
 * Line-based three-way merge, for a note changed by the user (local) and by someone else (remote,
 * e.g. the agent) since the version both started from (base). Edits to different lines merge;
 * both sides inserting at the same place keep both (local first); lines one side adds inside a
 * block the other side changed go after that block. Only changes to the same lines are a
 * conflict, and even then a line only the other side changed or removed never comes back: the
 * merge never reintroduces text deleted elsewhere unless the user typed it.
 */

import { diceSimilarity, isPrefixExtension } from "./text";

/** Replaces the lines `[start, end)` of the old text with `lines`. */
export interface LineHunk {
  start: number;
  end: number;
  lines: string[];
}

export interface MergeResult {
  text: string;
  /**
   * Both sides changed the same lines. `text` then has the user's version of the lines the user
   * changed there, and none of the other lines of that block (the remote text has them).
   */
  conflict: boolean;
}

/** Past this many edit steps the middle of two texts is treated as one replaced block. */
const MAX_EDIT_DISTANCE = 2_000;
/** Replaced blocks with more (old × new) line pairs than this aren't split line by line. */
const MAX_SPLIT_PAIRS = 10_000;
/** How similar (Dice, `diceSimilarity`) a new line must be to an old one to be that line edited. */
const EDITED_LINE_SIMILARITY = 0.5;

/** The hunks that turn `a` into `b` (Myers' O((N+M)·D) diff after trimming common ends). */
export function diffLines(a: readonly string[], b: readonly string[]): LineHunk[] {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }
  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  if (midA.length === 0 && midB.length === 0) return [];
  const pairs = commonPairs(midA, midB);
  if (pairs === null) return [{ start: prefix, end: a.length - suffix, lines: midB }];
  const hunks: LineHunk[] = [];
  let i = 0;
  let j = 0;
  for (const [pi, pj] of [...pairs, [midA.length, midB.length] as const]) {
    if (i < pi || j < pj)
      hunks.push({ start: prefix + i, end: prefix + pi, lines: midB.slice(j, pj) });
    i = pi + 1;
    j = pj + 1;
  }
  return hunks;
}

/** Matching line pairs of a longest common subsequence, or null past `MAX_EDIT_DISTANCE`. */
function commonPairs(a: readonly string[], b: readonly string[]): Array<[number, number]> | null {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] holds v[k] for k in [-d, d] after round d.
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    if (d > MAX_EDIT_DISTANCE) return null;
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
          ? v[offset + k + 1]!
          : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, d, n, m);
    }
    trace.push(v.slice(offset - d, offset + d + 1));
  }
  return null;
}

function backtrack(trace: readonly Int32Array[], depth: number, n: number, m: number) {
  const pairs: Array<[number, number]> = [];
  const at = (d: number, k: number) => trace[d]![k + d]!;
  let x = n;
  let y = m;
  for (let d = depth; d > 0; d--) {
    const k = x - y;
    const down = k === -d || (k !== d && at(d - 1, k - 1) < at(d - 1, k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(d - 1, prevK);
    const prevY = prevX - prevK;
    const midX = down ? prevX : prevX + 1;
    const midY = midX - k;
    while (x > midX && y > midY) {
      x--;
      y--;
      pairs.push([x, y]);
    }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    pairs.push([x, y]);
  }
  return pairs.reverse();
}

export function mergeText(base: string, local: string, remote: string): MergeResult {
  if (local === remote || remote === base) return { text: local, conflict: false };
  if (local === base) return { text: remote, conflict: false };
  const baseLines = base.split("\n");
  const changes = (text: string) =>
    diffLines(baseLines, text.split("\n")).flatMap((hunk) => splitReplacement(baseLines, hunk));
  const sides = [
    ...changes(local).map((hunk) => ({ hunk, local: true })),
    ...changes(remote).map((hunk) => ({ hunk, local: false })),
  ].sort((x, y) => x.hunk.start - y.hunk.start || x.hunk.end - y.hunk.end);

  const out: string[] = [];
  let conflict = false;
  let position = 0;
  let index = 0;
  while (index < sides.length) {
    const first = sides[index++]!;
    const start = first.hunk.start;
    let end = first.hunk.end;
    const cluster = [first];
    // A replaced range takes every hunk starting inside it; an insertion only other insertions at
    // the same place. Hunks that merely touch stay separate and apply one after the other.
    while (index < sides.length) {
      const next = sides[index]!.hunk;
      const joins =
        end > start ? next.start < end : next.start === start && next.end === next.start;
      if (!joins) break;
      cluster.push(sides[index++]!);
      end = Math.max(end, next.end);
    }
    out.push(...baseLines.slice(position, start));
    const mine = cluster.filter((s) => s.local).map((s) => s.hunk);
    const theirs = cluster.filter((s) => !s.local).map((s) => s.hunk);
    const localLines = applyHunks(baseLines, start, end, mine);
    if (theirs.length === 0) {
      out.push(...localLines);
    } else {
      const remoteLines = applyHunks(baseLines, start, end, theirs);
      if (mine.length === 0 || sameLines(localLines, remoteLines)) {
        out.push(...remoteLines);
      } else if (start === end) {
        out.push(...localLines, ...remoteLines);
      } else if (mine.every(isInsertion)) {
        out.push(...remoteLines, ...mine.flatMap((hunk) => hunk.lines));
      } else if (theirs.every(isInsertion)) {
        out.push(...localLines, ...theirs.flatMap((hunk) => hunk.lines));
      } else {
        // Every base line of the block is covered by a hunk, so the lines no local hunk covers
        // were changed or removed by the other side: keep only what the user wrote, then the
        // lines the other side added.
        conflict = true;
        out.push(
          ...mine.flatMap((hunk) => hunk.lines),
          ...theirs.filter(isInsertion).flatMap((hunk) => hunk.lines),
        );
      }
    }
    position = end;
  }
  out.push(...baseLines.slice(position));
  return { text: out.join("\n"), conflict };
}

/**
 * How likely `after` is `before` edited, for pairing lines inside a replaced block: their Dice
 * similarity when at least `EDITED_LINE_SIMILARITY`, that threshold when one extends the other
 * (typed on, or cut short, at the end), else 0 (not a pair).
 */
function editWeight(before: string, after: string): number {
  const similarity = diceSimilarity(before, after);
  if (similarity >= EDITED_LINE_SIMILARITY) return similarity;
  return isPrefixExtension(before, after) ? EDITED_LINE_SIMILARITY : 0;
}

/**
 * A diff reports a line edited next to lines added or removed as one replaced block, so an edit of
 * that line by the other side would swallow the added lines. This splits a replaced block into the
 * lines it edited, the lines it inserted and the lines it deleted: old and new lines are paired in
 * order, most similar first, where the new line can be the old one edited (`editWeight`). Blank
 * lines hold nothing to edit, so new lines in their place are an insertion and a deletion.
 */
function splitReplacement(base: readonly string[], hunk: LineHunk): LineHunk[] {
  const rows = hunk.end - hunk.start;
  const cols = hunk.lines.length;
  if (rows === 0 || cols === 0 || rows * cols > MAX_SPLIT_PAIRS) return [hunk];
  // score[i][j]: the best total weight pairing the first i old lines with the first j new ones.
  const weights: number[][] = [];
  const score: number[][] = [new Array<number>(cols + 1).fill(0)];
  for (let i = 1; i <= rows; i++) {
    weights.push([]);
    score.push([0]);
    for (let j = 1; j <= cols; j++) {
      const w = editWeight(base[hunk.start + i - 1]!, hunk.lines[j - 1]!);
      weights[i - 1]!.push(w);
      let best = Math.max(score[i - 1]![j]!, score[i]![j - 1]!);
      if (w > 0) best = Math.max(best, score[i - 1]![j - 1]! + w);
      score[i]!.push(best);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = rows;
  let j = cols;
  while (i > 0 && j > 0) {
    const w = weights[i - 1]![j - 1]!;
    if (w > 0 && score[i]![j] === score[i - 1]![j - 1]! + w) {
      pairs.push([--i, --j]);
    } else if (score[i]![j] === score[i - 1]![j]) {
      i--;
    } else {
      j--;
    }
  }
  const out: LineHunk[] = [];
  const push = (start: number, end: number, lines: string[]) => {
    if (start < end && lines.length > 0 && base.slice(start, end).every((line) => line === "")) {
      out.push({ start, end: start, lines }, { start, end, lines: [] });
    } else if (start < end || lines.length > 0) {
      out.push({ start, end, lines });
    }
  };
  let at = 0;
  let next = 0;
  for (const [pi, pj] of pairs.reverse()) {
    push(hunk.start + at, hunk.start + pi, hunk.lines.slice(next, pj));
    if (hunk.lines[pj] !== base[hunk.start + pi]) {
      push(hunk.start + pi, hunk.start + pi + 1, [hunk.lines[pj]!]);
    }
    at = pi + 1;
    next = pj + 1;
  }
  push(hunk.start + at, hunk.end, hunk.lines.slice(next));
  return out;
}

function applyHunks(
  base: readonly string[],
  start: number,
  end: number,
  hunks: readonly LineHunk[],
): string[] {
  const out: string[] = [];
  let at = start;
  for (const hunk of hunks) {
    out.push(...base.slice(at, hunk.start), ...hunk.lines);
    at = hunk.end;
  }
  out.push(...base.slice(at, end));
  return out;
}

function isInsertion(hunk: LineHunk): boolean {
  return hunk.start === hunk.end;
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}
