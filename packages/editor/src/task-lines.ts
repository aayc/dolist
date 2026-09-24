/**
 * Pure helpers for markdown list/task lines. Prefixes may include indentation and blockquote
 * markers (`> - [ ] task`), which the markdown parser also renders as tasks.
 */
import type { ChangeSpec, Line } from "@codemirror/state";

const PREFIX = String.raw`[ \t]*(?:>[ \t]?)*[ \t]*`;
const MARKER = String.raw`[-*+]|\d{1,9}[.)]`;
const TASK_RE = new RegExp(String.raw`^(${PREFIX})(${MARKER})([ \t]+)\[(.)\](?=[ \t]|$)`);
const LIST_RE = new RegExp(String.raw`^(${PREFIX})(${MARKER})([ \t]+|$)`);
const LEADING_RE = new RegExp(`^${PREFIX}`);

export interface TaskLineMatch {
  /** Offset of the status character (between the brackets) within the line. */
  statusOffset: number;
  statusChar: string;
}

export function matchTaskLine(text: string): TaskLineMatch | null {
  const m = TASK_RE.exec(text);
  if (!m) return null;
  const [, prefix = "", marker = "", space = "", statusChar = " "] = m;
  return { statusOffset: prefix.length + marker.length + space.length + 1, statusChar };
}

export function isListLine(text: string): boolean {
  return LIST_RE.test(text);
}

export function isDoneStatusChar(ch: string): boolean {
  return ch === "x" || ch === "X";
}

/** `[ ]` → `[x]`, `[x]` → `[ ]`, any other status (`/`, `-`, `>`, …) → `[x]`. */
export function nextToggleChar(statusChar: string): string {
  return isDoneStatusChar(statusChar) ? " " : "x";
}

/** Change that toggles the checkbox of a task line, or null if the line is not a task. */
export function toggleTaskChange(line: Line): ChangeSpec | null {
  const task = matchTaskLine(line.text);
  if (!task) return null;
  const from = line.from + task.statusOffset;
  return { from, to: from + 1, insert: nextToggleChar(task.statusChar) };
}

/**
 * Obsidian's "toggle checkbox status" for one line: plain text becomes `- [ ] text`, a list item
 * `- text` becomes `- [ ] text`, and a task toggles `[ ]` ↔ `[x]`. Blank lines only become tasks
 * when `allowBlank` is set (single-line invocations).
 */
export function checklistChange(line: Line, allowBlank: boolean): ChangeSpec | null {
  const toggle = toggleTaskChange(line);
  if (toggle) return toggle;
  const list = LIST_RE.exec(line.text);
  if (list) {
    const [whole, , , space = ""] = list;
    return space
      ? { from: line.from + whole.length, insert: "[ ] " }
      : { from: line.from + whole.length, insert: " [ ] " };
  }
  const leading = LEADING_RE.exec(line.text)?.[0] ?? "";
  if (!allowBlank && leading.length === line.text.length) return null;
  return { from: line.from + leading.length, insert: "- [ ] " };
}
