import { parseWikiLinks } from "./wikilinks";

/**
 * Task statuses. Beyond Obsidian's `[ ]`/`[x]`, we understand the common "alternate checkbox"
 * conventions: `[/]` in progress, `[-]` cancelled, `[>]` deferred/forwarded.
 */
export type TaskStatus = "open" | "done" | "in_progress" | "cancelled" | "deferred" | "other";

export interface ParsedTask {
  /** 0-based line index in the document. */
  line: number;
  /** Leading whitespace width (tab = 4 columns). */
  indent: number;
  /** Nesting depth among list items (0 = top level). */
  depth: number;
  /** List marker: `-`, `*`, `+`, `1.` or `1)`. */
  marker: string;
  /** The raw character between the brackets. */
  statusChar: string;
  status: TaskStatus;
  /** Task text after the checkbox, trimmed. */
  text: string;
  /** The full raw line. */
  raw: string;
  /** Document offset of the line start. */
  from: number;
  /** Document offset of the line end (exclusive of the newline). */
  to: number;
  /** Document offset where the task text begins. */
  textFrom: number;
  /** Line of the nearest ancestor task, if this task is nested under one. */
  parentLine: number | null;
  /** Non-task lines nested under this task (sub-bullets / notes), trimmed. Agent context. */
  notes: string[];
  /** Wikilink targets mentioned in the task text (e.g. forwarded-to daily notes). */
  links: string[];
}

const TASK_RE = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+\[(.)\](?:[ \t]+(.*))?$/;
const LIST_ITEM_RE = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const FENCE_RE = /^[ \t]*(`{3,}|~{3,})/;

export function statusFromChar(ch: string): TaskStatus {
  switch (ch) {
    case " ":
      return "open";
    case "x":
    case "X":
      return "done";
    case "/":
      return "in_progress";
    case "-":
      return "cancelled";
    case ">":
    case "<":
      return "deferred";
    default:
      return "other";
  }
}

export function charFromStatus(status: TaskStatus): string {
  switch (status) {
    case "open":
      return " ";
    case "done":
      return "x";
    case "in_progress":
      return "/";
    case "cancelled":
      return "-";
    case "deferred":
      return ">";
    default:
      return " ";
  }
}

/** True for statuses that mean "nothing left to do" (done, cancelled, deferred). */
export function isClosedStatus(status: TaskStatus): boolean {
  return status === "done" || status === "cancelled" || status === "deferred";
}

function indentWidth(ws: string): number {
  let width = 0;
  for (const ch of ws) width += ch === "\t" ? 4 : 1;
  return width;
}

/**
 * Parses every markdown checkbox task in a document. Skips YAML frontmatter and fenced code blocks.
 * Runs in a single linear pass; a 2k-line note parses in well under a millisecond.
 */
export function parseTasks(markdown: string): ParsedTask[] {
  const tasks: ParsedTask[] = [];
  const lines = markdown.split("\n");
  // Stack of open list items for depth/parent tracking.
  const stack: Array<{ indent: number; taskIndex: number | null }> = [];
  let offset = 0;
  let fence: string | null = null;
  let inFrontmatter = lines[0]?.replace(/\r$/, "") === "---";

  for (let i = 0; i < lines.length; i++) {
    const rawWithCr = lines[i]!;
    const raw = rawWithCr.endsWith("\r") ? rawWithCr.slice(0, -1) : rawWithCr;
    const from = offset;
    offset += rawWithCr.length + 1;

    if (inFrontmatter) {
      if (i > 0 && (raw === "---" || raw === "...")) inFrontmatter = false;
      continue;
    }
    const fenceMatch = FENCE_RE.exec(raw);
    if (fence) {
      if (fenceMatch && fenceMatch[1]![0] === fence[0] && fenceMatch[1]!.length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1]!;
      continue;
    }
    if (raw.trim() === "") continue;

    const lineIndent = indentWidth(/^[ \t]*/.exec(raw)![0]);
    // Any line (list item or paragraph) closes every open item at the same or deeper indent.
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= lineIndent) stack.pop();
    const owner = innermostTask(stack);

    const task = TASK_RE.exec(raw);
    if (task) {
      const [, ws = "", marker = "-", statusChar = " ", body] = task;
      const text = (body ?? "").trim();
      const textStart = body === undefined ? raw.length : raw.length - body.length;
      const parsed: ParsedTask = {
        line: i,
        indent: indentWidth(ws),
        depth: stack.length,
        marker,
        statusChar,
        status: statusFromChar(statusChar),
        text,
        raw,
        from,
        to: from + raw.length,
        textFrom: from + textStart,
        parentLine: owner === null ? null : tasks[owner]!.line,
        notes: [],
        links: parseWikiLinks(text).map((l) => l.target),
      };
      tasks.push(parsed);
      stack.push({ indent: parsed.indent, taskIndex: tasks.length - 1 });
      continue;
    }

    // Non-task line nested under a task (sub-bullet or continuation): keep it as agent context.
    if (owner !== null) {
      tasks[owner]!.notes.push(raw.trim().replace(/^([-*+]|\d{1,9}[.)])\s+/, ""));
    }
    if (LIST_ITEM_RE.test(raw)) stack.push({ indent: lineIndent, taskIndex: null });
  }
  return tasks;
}

function innermostTask(stack: ReadonlyArray<{ taskIndex: number | null }>): number | null {
  for (let i = stack.length - 1; i >= 0; i--) {
    const idx = stack[i]!.taskIndex;
    if (idx !== null) return idx;
  }
  return null;
}

/** Toggles `[ ]` ↔ `[x]` on a task line; other statuses become done. Non-task lines unchanged. */
export function toggleTaskLine(line: string): string {
  const m = TASK_RE.exec(line);
  if (!m) return line;
  const next = statusFromChar(m[3]!) === "open" ? "x" : " ";
  return setStatusCharOnLine(line, next);
}

export function setStatusCharOnLine(line: string, statusChar: string): string {
  return line.replace(/^([ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[).(\])/, `$1${statusChar}$2`);
}

export function isTaskLine(line: string): boolean {
  return TASK_RE.test(line);
}

/** Tasks with no meaningful text yet (e.g. the empty `- [ ] ` from the daily template). */
export function isBlankTaskText(text: string): boolean {
  return text.replace(/[\s.…-]/g, "").length < 2;
}
