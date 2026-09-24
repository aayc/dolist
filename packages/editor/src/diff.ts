import { diffLines } from "@ddl/core";

export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

const NEWLINE = 10;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Slides the segment `[from, from + length)` of `text` left to the nearest line start, if the
 * text allows it (each step needs the char before the segment to equal its last char).
 */
function slideToLineStart(text: string, from: number, length: number): number {
  let pos = from;
  while (pos > 0 && text.charCodeAt(pos - 1) !== NEWLINE) {
    if (text.charCodeAt(pos - 1) !== text.charCodeAt(pos - 1 + length)) return from;
    pos--;
  }
  return pos;
}

/**
 * The single replacement turning `current` into `next`: common prefix/suffix trimmed, never splitting
 * a surrogate pair. Whole-line insertions/deletions are aligned to line starts, so text inserted
 * above a line maps positions on that line (cursor, badges) down instead of leaving them behind.
 */
export function minimalChange(current: string, next: string): TextChange | null {
  if (current === next) return null;
  const max = Math.min(current.length, next.length);
  let start = 0;
  while (start < max && current.charCodeAt(start) === next.charCodeAt(start)) start++;
  let end = 0;
  while (
    end < max - start &&
    current.charCodeAt(current.length - 1 - end) === next.charCodeAt(next.length - 1 - end)
  ) {
    end++;
  }
  if (start > 0 && isHighSurrogate(current.charCodeAt(start - 1))) start--;
  if (end > 0 && isLowSurrogate(current.charCodeAt(current.length - end))) end--;

  let from = start;
  let to = current.length - end;
  let insertTo = next.length - end;
  if (from === to && next.slice(from, insertTo).includes("\n")) {
    const shift = from - slideToLineStart(next, from, insertTo - from);
    from -= shift;
    to -= shift;
    insertTo -= shift;
  } else if (from === insertTo && current.slice(from, to).includes("\n")) {
    const shift = from - slideToLineStart(current, from, to - from);
    from -= shift;
    to -= shift;
    insertTo -= shift;
  }
  return { from, to, insert: next.slice(from, insertTo) };
}

/**
 * The changes turning `current` into `next`: one per run of changed lines (trimmed within the run
 * like `minimalChange`), sorted and non-overlapping, so positions on lines that didn't change (the
 * cursor, badges, the undo history of the user's own edits) are left alone.
 */
export function documentChanges(current: string, next: string): TextChange[] {
  if (current === next) return [];
  const oldLines = current.split("\n");
  const starts: number[] = [];
  let offset = 0;
  for (const line of oldLines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  const out: TextChange[] = [];
  const add = (change: TextChange) => {
    const last = out[out.length - 1];
    // Hunks around an empty line can touch (e.g. lines added before and after it).
    if (last && last.to === change.from) {
      out[out.length - 1] = { from: last.from, to: change.to, insert: last.insert + change.insert };
    } else {
      out.push(change);
    }
  };
  for (const { start, end, lines } of diffLines(oldLines, next.split("\n"))) {
    if (start === end) {
      add(
        start < oldLines.length
          ? { from: starts[start]!, to: starts[start]!, insert: `${lines.join("\n")}\n` }
          : { from: current.length, to: current.length, insert: `\n${lines.join("\n")}` },
      );
    } else if (lines.length === 0) {
      if (end < oldLines.length) add({ from: starts[start]!, to: starts[end]!, insert: "" });
      else add({ from: Math.max(0, starts[start]! - 1), to: current.length, insert: "" });
    } else {
      const from = starts[start]!;
      const to = starts[end - 1]! + oldLines[end - 1]!.length;
      const change = minimalChange(current.slice(from, to), lines.join("\n"));
      if (change) add({ from: from + change.from, to: from + change.to, insert: change.insert });
    }
  }
  return out;
}

/** CodeMirror stores `\n`-separated lines; normalize before comparing with its content. */
export function normalizeLineEndings(text: string): string {
  return text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
}
