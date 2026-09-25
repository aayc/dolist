import { diceSimilarity, isPrefixExtension } from "../text";
import { stripAgentMarker } from "./agent-text";
import { type TrackedTask, trackTasks } from "./task-tracker";
import { isTaskLine, type ParsedTask, parseTasks } from "./tasks";

/**
 * Whether `after` is still recognizably the line `before` was: the same text, still being typed or
 * trimmed, or similar (Dice ≥ 0.5) — the task tracker's rule for an edited task. Blank is never.
 */
export function isSameLineEdited(before: string, after: string): boolean {
  const a = before.trim();
  const b = after.trim();
  if (a === "" || b === "") return false;
  return a === b || isPrefixExtension(a, b) || diceSimilarity(a, b) >= 0.5;
}

/**
 * The 0-based line of `lines` that is still `text` (see `isSameLineEdited`): `line` itself when it
 * is, else the nearest line with that exact text, else the nearest similar one; null when none is.
 */
export function findEditedLine(
  lines: readonly string[],
  line: number,
  text: string,
): number | null {
  if (line >= 0 && line < lines.length && isSameLineEdited(text, lines[line]!)) return line;
  const wanted = text.trim();
  let exact: number | null = null;
  let similar: number | null = null;
  const nearer = (i: number, best: number | null) =>
    best === null || Math.abs(i - line) < Math.abs(best - line);
  for (let i = 0; i < lines.length; i++) {
    const candidate = lines[i]!;
    if (candidate.trim() === wanted && wanted !== "") {
      if (nearer(i, exact)) exact = i;
    } else if (exact === null && nearer(i, similar) && isSameLineEdited(text, candidate)) {
      similar = i;
    }
  }
  return exact ?? similar;
}

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

/** A non-task line the orchestrator attached a thread to (`TaskAgentRecord.anchor === "line"`). */
export interface LineAnchor {
  anchorId: string;
  /** The line, trimmed and without an agent marker. */
  text: string;
  line: number;
}

/** Every line a thread can be anchored to: not blank, not a task. Text as in `LineAnchor`. */
export function anchorableLines(doc: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  const lines = doc.split("\n");
  for (let line = 0; line < lines.length; line++) {
    const raw = lines[line]!.replace(/\r$/, "");
    if (isTaskLine(raw)) continue;
    const text = stripAgentMarker(raw).trim();
    if (text !== "") out.push({ line, text });
  }
  return out;
}

/**
 * Re-finds line anchors in an edited document with the task tracker's identity rules (same text,
 * then the most similar nearby text, then an in-place rewrite of the same line). Returns
 * anchorId → where the anchor is now, for every anchor still in the document.
 */
export function resolveLineAnchors(
  doc: string,
  anchors: readonly LineAnchor[],
): Map<string, { line: number; text: string }> {
  const candidates: ParsedTask[] = anchorableLines(doc).map(({ line, text }) => ({
    line,
    indent: 0,
    depth: 0,
    marker: "-",
    statusChar: " ",
    status: "open",
    text,
    raw: text,
    from: 0,
    to: 0,
    textFrom: 0,
    parentLine: null,
    notes: [],
    links: [],
  }));
  const previous: TrackedTask[] = anchors.map((a) => ({
    id: a.anchorId,
    text: a.text,
    status: "open",
    line: a.line,
    depth: 0,
    parentId: null,
    notes: [],
    firstSeenAt: 0,
    updatedAt: 0,
  }));
  const ids = new Set(anchors.map((a) => a.anchorId));
  const { tasks } = trackTasks(previous, candidates, { idFactory: () => "" });
  const out = new Map<string, { line: number; text: string }>();
  for (const t of tasks) if (t.id && ids.has(t.id)) out.set(t.id, { line: t.line, text: t.text });
  return out;
}
