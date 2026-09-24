/**
 * Line-based diff (Myers' O(ND) algorithm) and three-way merge (diff3), used by the sync engine to
 * merge notes edited on two devices since their last common version. Pure and dependency-free.
 */

export interface DiffHunk {
  /** Index of the first replaced line in the old sequence (insertion point if `oldLength` is 0). */
  oldStart: number;
  oldLength: number;
  newStart: number;
  newLength: number;
}

export interface DiffOptions {
  /**
   * Upper bound on the edit distance explored. Beyond it the differing middle is reported as one
   * hunk: still correct, just coarser (merges then conflict instead of interleaving). Bounds time
   * to O((N+M)·D) and memory to O(D²).
   */
  maxEditDistance?: number;
}

const DEFAULT_MAX_EDIT_DISTANCE = 2000;

/** Minimal set of hunks turning `oldLines` into `newLines`, in order. */
export function diffLines(
  oldLines: readonly string[],
  newLines: readonly string[],
  options: DiffOptions = {},
): DiffHunk[] {
  let start = 0;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (start < oldEnd && start < newEnd && oldLines[start] === newLines[start]) start++;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  if (start === oldEnd && start === newEnd) return [];
  const whole: DiffHunk = {
    oldStart: start,
    oldLength: oldEnd - start,
    newStart: start,
    newLength: newEnd - start,
  };
  if (start === oldEnd || start === newEnd) return [whole];
  const matches = myersMatches(
    oldLines,
    newLines,
    start,
    oldEnd,
    start,
    newEnd,
    options.maxEditDistance ?? DEFAULT_MAX_EDIT_DISTANCE,
  );
  return matches ? hunksBetweenMatches(matches, start, oldEnd, start, newEnd) : [whole];
}

/**
 * Myers' greedy forward search over the window `a[aStart, aEnd)` × `b[bStart, bEnd)`, keeping the
 * furthest-reaching frontier of every step to backtrack the matched line pairs. Returns null when
 * the edit distance exceeds `maxD`.
 */
function myersMatches(
  a: readonly string[],
  b: readonly string[],
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
  maxD: number,
): Array<[number, number]> | null {
  const n = aEnd - aStart;
  const m = bEnd - bStart;
  const limit = Math.min(n + m, Math.max(0, maxD));
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  // trace[d] holds the frontier before step d, for diagonals -(d+1)..(d+1).
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= limit && found < 0; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
          ? v[offset + k + 1]!
          : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[aStart + x] === b[bStart + y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) return null;

  const matches: Array<[number, number]> = [];
  let x = n;
  let y = m;
  for (let d = found; d >= 0; d--) {
    const frontier = trace[d]!;
    const at = (k: number) => frontier[k + d + 1]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      if (x < n && y < m) matches.push([aStart + x, bStart + y]);
    }
    x = prevX;
    y = prevY;
  }
  return matches.reverse();
}

function hunksBetweenMatches(
  matches: ReadonlyArray<readonly [number, number]>,
  oldStart: number,
  oldEnd: number,
  newStart: number,
  newEnd: number,
): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let i = oldStart;
  let j = newStart;
  for (const [oldIndex, newIndex] of matches) {
    if (oldIndex > i || newIndex > j) {
      hunks.push({ oldStart: i, oldLength: oldIndex - i, newStart: j, newLength: newIndex - j });
    }
    i = oldIndex + 1;
    j = newIndex + 1;
  }
  if (i < oldEnd || j < newEnd) {
    hunks.push({ oldStart: i, oldLength: oldEnd - i, newStart: j, newLength: newEnd - j });
  }
  return hunks;
}

// ── diff3 ──────────────────────────────────────────────────────────────────

export type MergeRegion =
  /** Lines both sides agree on (unchanged, or changed by one side only). */
  | { stable: true; lines: string[] }
  /** Both sides changed this stretch of the base. */
  | { stable: false; ours: string[]; base: string[]; theirs: string[] };

type Side = "ours" | "theirs";

interface SideHunk {
  side: Side;
  baseStart: number;
  baseEnd: number;
  sideStart: number;
  sideEnd: number;
}

/**
 * Splits a three-way comparison into stable and unstable regions (diff3). Changes that overlap in
 * the base, and insertions by both sides at the same spot, form one unstable region. Unlike GNU
 * diff3, changes that merely touch (edits to adjacent lines, or an insertion next to an edit) stay
 * separate and merge cleanly: in a to-do list, neighbouring lines are independent items.
 */
export function diff3Regions(
  base: readonly string[],
  ours: readonly string[],
  theirs: readonly string[],
  options: DiffOptions = {},
): MergeRegion[] {
  const toSide = (side: Side) => (h: DiffHunk) => ({
    side,
    baseStart: h.oldStart,
    baseEnd: h.oldStart + h.oldLength,
    sideStart: h.newStart,
    sideEnd: h.newStart + h.newLength,
  });
  const hunks: SideHunk[] = [
    ...diffLines(base, ours, options).map(toSide("ours")),
    ...diffLines(base, theirs, options).map(toSide("theirs")),
  ].sort(
    // Insertions sort before edits starting at the same line, so the order of sides can't matter.
    (x, y) =>
      x.baseStart - y.baseStart ||
      x.baseEnd - y.baseEnd ||
      (x.side === y.side ? 0 : x.side === "ours" ? -1 : 1),
  );

  const regions: MergeRegion[] = [];
  let cursor = 0;
  let i = 0;
  while (i < hunks.length) {
    const first = hunks[i]!;
    const regionStart = first.baseStart;
    let regionEnd = first.baseEnd;
    let j = i + 1;
    while (j < hunks.length) {
      const next = hunks[j]!;
      const overlaps = next.baseStart < regionEnd;
      const sameInsertionPoint =
        regionStart === regionEnd && next.baseStart === regionEnd && next.baseEnd === regionEnd;
      if (!overlaps && !sameInsertionPoint) break;
      regionEnd = Math.max(regionEnd, next.baseEnd);
      j++;
    }
    const group = hunks.slice(i, j);
    i = j;

    if (regionStart > cursor)
      regions.push({ stable: true, lines: base.slice(cursor, regionStart) });
    if (group.length === 1) {
      const lines = (first.side === "ours" ? ours : theirs).slice(first.sideStart, first.sideEnd);
      if (lines.length > 0) regions.push({ stable: true, lines });
    } else {
      regions.push({
        stable: false,
        ours: sideSlice(ours, "ours", group, base, regionStart, regionEnd),
        base: base.slice(regionStart, regionEnd),
        theirs: sideSlice(theirs, "theirs", group, base, regionStart, regionEnd),
      });
    }
    cursor = regionEnd;
  }
  if (cursor < base.length) regions.push({ stable: true, lines: base.slice(cursor) });
  return regions;
}

/** What one side holds for the base range [regionStart, regionEnd). */
function sideSlice(
  lines: readonly string[],
  side: Side,
  group: readonly SideHunk[],
  base: readonly string[],
  regionStart: number,
  regionEnd: number,
): string[] {
  const own = group.filter((h) => h.side === side);
  if (own.length === 0) return base.slice(regionStart, regionEnd);
  let sideStart = Number.POSITIVE_INFINITY;
  let sideEnd = Number.NEGATIVE_INFINITY;
  let baseStart = Number.POSITIVE_INFINITY;
  let baseEnd = Number.NEGATIVE_INFINITY;
  for (const h of own) {
    sideStart = Math.min(sideStart, h.sideStart);
    sideEnd = Math.max(sideEnd, h.sideEnd);
    baseStart = Math.min(baseStart, h.baseStart);
    baseEnd = Math.max(baseEnd, h.baseEnd);
  }
  // Outside its own hunks a side matches the base line for line, so offsets carry over.
  return lines.slice(sideStart - (baseStart - regionStart), sideEnd + (regionEnd - baseEnd));
}

export interface MergeOptions extends DiffOptions {
  /**
   * When both sides only inserted lines at the same spot, keep both (ours first) instead of
   * reporting a conflict. Suits append-heavy notes such as to-do lists.
   */
  unionInsertions?: boolean;
}

export type MergeLinesResult =
  | { clean: true; lines: string[] }
  /** `lines` contains git-style conflict markers around each unresolved region. */
  | { clean: false; lines: string[]; conflicts: number };

export function mergeLines(
  base: readonly string[],
  ours: readonly string[],
  theirs: readonly string[],
  options: MergeOptions = {},
): MergeLinesResult {
  const out: string[] = [];
  let conflicts = 0;
  for (const region of diff3Regions(base, ours, theirs, options)) {
    if (region.stable) {
      append(out, region.lines);
      continue;
    }
    const resolved = resolveRegion(region, options);
    if (resolved) {
      append(out, resolved);
      continue;
    }
    conflicts++;
    out.push("<<<<<<< ours");
    append(out, region.ours);
    out.push("||||||| base");
    append(out, region.base);
    out.push("=======");
    append(out, region.theirs);
    out.push(">>>>>>> theirs");
  }
  return conflicts === 0 ? { clean: true, lines: out } : { clean: false, lines: out, conflicts };
}

export type MergeTextResult =
  | { clean: true; text: string }
  | { clean: false; text: string; conflicts: number };

/** Three-way merge of whole texts, line by line. Line endings are preserved as written. */
export function mergeText(
  base: string,
  ours: string,
  theirs: string,
  options: MergeOptions = {},
): MergeTextResult {
  if (ours === theirs) return { clean: true, text: ours };
  if (base === ours) return { clean: true, text: theirs };
  if (base === theirs) return { clean: true, text: ours };
  const result = mergeLines(base.split("\n"), ours.split("\n"), theirs.split("\n"), options);
  const text = result.lines.join("\n");
  return result.clean ? { clean: true, text } : { clean: false, text, conflicts: result.conflicts };
}

function resolveRegion(
  region: Extract<MergeRegion, { stable: false }>,
  options: MergeOptions,
): string[] | null {
  if (sameLines(region.ours, region.theirs)) return region.ours;
  if (sameLines(region.ours, region.base)) return region.theirs;
  if (sameLines(region.theirs, region.base)) return region.ours;
  if (options.unionInsertions && region.base.length === 0)
    return [...region.ours, ...region.theirs];
  return null;
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

function append(target: string[], lines: readonly string[]): void {
  for (const line of lines) target.push(line);
}
