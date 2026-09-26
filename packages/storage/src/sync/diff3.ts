/**
 * Three-way merge (diff3) over `@ddl/core`'s line diff, used by the sync engine to merge notes
 * edited on two devices since their last common version. Pure and dependency-free.
 */
import { diffLines } from "@ddl/core";

type MergeRegion =
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

function sideHunks(base: readonly string[], lines: readonly string[], side: Side): SideHunk[] {
  let shift = 0;
  return diffLines(base, lines).map((h) => {
    const sideStart = h.start + shift;
    shift += h.lines.length - (h.end - h.start);
    return {
      side,
      baseStart: h.start,
      baseEnd: h.end,
      sideStart,
      sideEnd: sideStart + h.lines.length,
    };
  });
}

/**
 * Splits a three-way comparison into stable and unstable regions (diff3). Changes that overlap in
 * the base, and insertions by both sides at the same spot, form one unstable region. Unlike GNU
 * diff3, changes that merely touch (edits to adjacent lines, or an insertion next to an edit) stay
 * separate and merge cleanly: in a to-do list, neighbouring lines are independent items.
 */
function diff3Regions(
  base: readonly string[],
  ours: readonly string[],
  theirs: readonly string[],
): MergeRegion[] {
  const hunks = [...sideHunks(base, ours, "ours"), ...sideHunks(base, theirs, "theirs")].sort(
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

type MergeLinesResult =
  | { clean: true; lines: string[] }
  /** `lines` contains git-style conflict markers around each unresolved region. */
  | { clean: false; lines: string[]; conflicts: number };

/**
 * Merges line by line. When both sides only inserted lines at the same spot, both are kept (ours
 * first) instead of reporting a conflict: notes are append-heavy to-do lists.
 */
export function mergeLines(
  base: readonly string[],
  ours: readonly string[],
  theirs: readonly string[],
): MergeLinesResult {
  const out: string[] = [];
  let conflicts = 0;
  for (const region of diff3Regions(base, ours, theirs)) {
    if (region.stable) {
      append(out, region.lines);
      continue;
    }
    const resolved = resolveRegion(region);
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

type MergeTextResult =
  | { clean: true; text: string }
  | { clean: false; text: string; conflicts: number };

/** `mergeLines` over whole texts. Line endings are preserved as written. */
export function mergeText3(base: string, ours: string, theirs: string): MergeTextResult {
  if (ours === theirs) return { clean: true, text: ours };
  if (base === ours) return { clean: true, text: theirs };
  if (base === theirs) return { clean: true, text: ours };
  const result = mergeLines(textLines(base), textLines(ours), textLines(theirs));
  // A side's last line carries no line ending; if the notes use CRLF, so do the breaks we add.
  const crlf = [base, ours, theirs].some(usesCrlf) && ![base, ours, theirs].some(hasBareLf);
  const lines = crlf
    ? result.lines.map((line, i) =>
        i < result.lines.length - 1 && !line.endsWith("\r") ? `${line}\r` : line,
      )
    : result.lines;
  const text = lines.join("\n");
  return result.clean ? { clean: true, text } : { clean: false, text, conflicts: result.conflicts };
}

const usesCrlf = (text: string) => text.includes("\r\n");
const hasBareLf = (text: string) => /(^|[^\r])\n/.test(text);

/** An empty text has no lines (not one empty line), so emptying a note merges like deleting. */
function textLines(text: string): string[] {
  return text === "" ? [] : text.split("\n");
}

function resolveRegion(region: Extract<MergeRegion, { stable: false }>): string[] | null {
  if (sameLines(region.ours, region.theirs)) return region.ours;
  if (sameLines(region.ours, region.base)) return region.theirs;
  if (sameLines(region.theirs, region.base)) return region.ours;
  if (region.base.length === 0) return [...region.ours, ...region.theirs];
  return null;
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

function append(target: string[], lines: readonly string[]): void {
  for (const line of lines) target.push(line);
}
