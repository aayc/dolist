import {
  errorResult,
  isAgentLine,
  isDrawingMarkdown,
  isDrawingPath,
  isHiddenPath,
  isMarkdownPath,
  isTaskLine,
  markAgentLine,
  normalizePath,
  pluralize,
  setStatusCharOnLine,
  stripAgentMarker,
  type ToolSpec,
  textResult,
} from "@ddl/core";
import { ConflictError, type StorageProvider } from "@ddl/storage";
import { quote } from "../prompts/format";
import {
  type EditNoteInput,
  NOTE_EDIT_OPS,
  type NoteEdit,
  type NoteEditOp,
  TOOL,
} from "./contracts";
import {
  asInput,
  guarded,
  optionalString,
  requireEnum,
  type ToolInput,
  ToolInputError,
} from "./input";

const MAX_EDITS = 20;
const MAX_LINES_PER_EDIT = 30;
const MAX_LINE_CHARS = 1_000;
/** A quoted line is still found this many lines away from the number given (models miscount). */
const SEARCH_RADIUS = 15;
const WRITE_ATTEMPTS = 3;

/** Where a task or anchor is now: its note, 0-based line and text (as tracked). */
export interface NoteItemLocation {
  notePath: string;
  line: number;
  text: string;
}

export interface NoteEditHost {
  storage: StorageProvider;
  locate(taskId: string): NoteItemLocation | null;
  /** The thread that signs lines written for `taskId` (created on demand); null without a task. */
  threadFor(taskId: string | null): string | null;
  defaultNotePath(): string;
  /** Resolves once the user has paused typing in the note (bounded). */
  waitForPause(notePath: string): Promise<void>;
  /** After a write: the lines the agent added or rewrote. */
  onEdited?(edit: {
    notePath: string;
    taskId: string | null;
    threadId: string | null;
    lines: string[];
  }): void;
}

export interface PlannedNoteEdit {
  content: string;
  /** Every line the agent wrote (with its marker). */
  written: string[];
  /** One phrase per edit, for the tool result. */
  changes: string[];
}

interface LineChange {
  at: number;
  /** Lines removed at `at` (0 or 1). */
  remove: number;
  insert: string[];
  order: number;
}

/**
 * Applies `edits` to `content` as one change: every edit refers to the note as it is now. New and
 * rewritten lines are marked as the agent's; lines are found by their quoted text near the number
 * given. Throws `ToolInputError` with a correction for the model when an edit doesn't fit the note.
 */
export function planNoteEdits(
  content: string,
  edits: readonly NoteEdit[],
  options: {
    threadId: string | null;
    locate: (taskId: string) => { line: number; text: string } | null;
  },
): PlannedNoteEdit {
  const lines = content.split("\n");
  const changes: LineChange[] = [];
  const phrases: string[] = [];
  const written: string[] = [];
  const replaced = new Set<number>();
  const mark = (line: string) => markAgentLine(line, options.threadId);
  const replaceOnce = (index: number) => {
    if (replaced.has(index))
      throw new ToolInputError(`Line ${index + 1} is changed twice in one call.`);
    replaced.add(index);
  };

  edits.forEach((edit, order) => {
    switch (edit.op) {
      case "add_under": {
        const target = itemLine(lines, edit.taskId!, options.locate);
        const slot = childSlot(lines, target);
        const insert = edit.lines!.map((line) =>
          mark(slot.indent + (slot.list ? listItem(line) : line.trim())),
        );
        changes.push({ at: slot.at, remove: 0, insert, order });
        written.push(...insert);
        phrases.push(
          `added ${pluralize(insert.length, "line")} under ${quote(itemText(lines[target]!), 80)}`,
        );
        return;
      }
      case "insert_after": {
        const at = edit.line === 0 ? 0 : findLine(lines, edit.line! - 1, edit.expect!) + 1;
        const insert = edit.lines!.map((line) => mark(line.replace(/\s+$/, "")));
        changes.push({ at, remove: 0, insert, order });
        written.push(...insert);
        phrases.push(`added ${pluralize(insert.length, "line")} after line ${at}`);
        return;
      }
      case "append": {
        let at = lines.length;
        while (at > 0 && lines[at - 1]!.trim() === "") at--;
        const insert = edit.lines!.map((line) => mark(line.replace(/\s+$/, "")));
        changes.push({ at, remove: 0, insert, order });
        written.push(...insert);
        phrases.push(`added ${pluralize(insert.length, "line")} at the end`);
        return;
      }
      case "replace": {
        const index = findLine(lines, edit.line! - 1, edit.expect!);
        checkOwnership(lines[index]!, edit.mine, index);
        replaceOnce(index);
        const indent = /^[ \t]*/.exec(lines[index]!)![0];
        const next = mark(indent + edit.text!.trim());
        changes.push({ at: index, remove: 1, insert: [next], order });
        written.push(next);
        phrases.push(`rewrote line ${index + 1}`);
        return;
      }
      case "delete": {
        const index = findLine(lines, edit.line! - 1, edit.expect!);
        checkOwnership(lines[index]!, edit.mine, index);
        replaceOnce(index);
        changes.push({ at: index, remove: 1, insert: [], order });
        phrases.push(`deleted line ${index + 1}`);
        return;
      }
      case "set_checkbox": {
        const index = itemLine(lines, edit.taskId!, options.locate);
        if (!isTaskLine(lines[index]!)) throw new ToolInputError(`${edit.taskId} is not a task.`);
        checkOwnership(lines[index]!, edit.mine, index);
        replaceOnce(index);
        const next = setStatusCharOnLine(lines[index]!, edit.checked ? "x" : " ");
        changes.push({ at: index, remove: 1, insert: [next], order });
        phrases.push(
          `${edit.checked ? "checked" : "unchecked"} ${quote(itemText(lines[index]!), 80)}`,
        );
        return;
      }
    }
  });

  // Bottom-up so indices stay valid; at one index the replaced line goes first, then the inserts
  // (later edits first, so the lines end up in the order the edits were given).
  changes.sort((a, b) => b.at - a.at || b.remove - a.remove || b.order - a.order);
  for (const change of changes) lines.splice(change.at, change.remove, ...change.insert);
  return { content: lines.join("\n"), written, changes: phrases };
}

/** Text of a line for comparing with what the model quoted: no marker, annotation or extra blanks. */
function comparable(text: string): string {
  return stripAgentMarker(text.replace(/⟪[^⟫]*⟫/g, ""))
    .trim()
    .replace(/\s+/g, " ");
}

/** A line's text without list marker and checkbox (how tasks and anchors are tracked). */
function itemText(line: string): string {
  return comparable(line).replace(/^(?:[-*+]|\d{1,9}[.)])\s+(?:\[[^\]\n]\]\s*)?/, "");
}

/**
 * The 0-based line that reads `quoted` (ignoring agent markers, ⟪…⟫ notes, blanks, and for list
 * items the marker and checkbox): `index` when it does, else the nearest one within reach.
 */
export function findQuotedLine(
  lines: readonly string[],
  index: number,
  quoted: string,
): number | null {
  const wanted = comparable(quoted);
  const matches = (i: number) =>
    i >= 0 &&
    i < lines.length &&
    (comparable(lines[i]!) === wanted || itemText(lines[i]!) === wanted);
  if (matches(index)) return index;
  for (let d = 1; d <= SEARCH_RADIUS; d++) {
    if (matches(index - d)) return index - d;
    if (matches(index + d)) return index + d;
  }
  return null;
}

function findLine(lines: readonly string[], index: number, expect: string): number {
  const found = findQuotedLine(lines, index, expect);
  if (found !== null) return found;
  const actual =
    index >= 0 && index < lines.length
      ? quote(comparable(lines[index]!), 120)
      : "nothing (the note is shorter)";
  throw new ToolInputError(
    `Line ${index + 1} reads ${actual}, not ${quote(expect, 120)}, and no nearby line matches. Read the note again and retry.`,
  );
}

function itemLine(
  lines: readonly string[],
  taskId: string,
  locate: (taskId: string) => { line: number; text: string } | null,
): number {
  const at = locate(taskId);
  if (!at) throw new ToolInputError(`Unknown task id "${taskId}" in this note.`);
  // The tracked line can trail a very recent edit: confirm it by the item's text.
  const wanted = comparable(at.text);
  const matches = (i: number) =>
    i >= 0 &&
    i < lines.length &&
    (itemText(lines[i]!) === wanted || comparable(lines[i]!) === wanted);
  if (matches(at.line)) return at.line;
  for (let d = 1; d <= SEARCH_RADIUS; d++) {
    if (matches(at.line - d)) return at.line - d;
    if (matches(at.line + d)) return at.line + d;
  }
  throw new ToolInputError(`Couldn't find ${quote(at.text, 80)} (${taskId}) in the note anymore.`);
}

/**
 * Where lines go "under" an item: after its nested lines (a list item's deeper-indented lines, or
 * the agent's lines right after a heading or paragraph), at its children's indentation.
 */
function childSlot(
  lines: readonly string[],
  target: number,
): { at: number; indent: string; list: boolean } {
  const line = lines[target]!;
  const base = /^[ \t]*/.exec(line)![0];
  const list = /^[ \t]*(?:[-*+]|\d{1,9}[.)])\s/.test(line);
  let at = target + 1;
  if (!list) {
    while (at < lines.length && isAgentLine(lines[at]!)) at++;
    return { at, indent: base, list: false };
  }
  let childIndent: string | null = null;
  while (at < lines.length) {
    const next = lines[at]!;
    if (next.trim() === "") break;
    const indent = /^[ \t]*/.exec(next)![0];
    if (width(indent) <= width(base)) break;
    childIndent ??= indent;
    at++;
  }
  return { at, indent: childIndent ?? `${base}${base.includes("\t") ? "\t" : "  "}`, list: true };
}

function width(indent: string): number {
  let columns = 0;
  for (const ch of indent) columns += ch === "\t" ? 4 : 1;
  return columns;
}

function listItem(text: string): string {
  const trimmed = text.trim();
  return /^(?:[-*+]|\d{1,9}[.)])\s/.test(trimmed) ? trimmed : `- ${trimmed}`;
}

function checkOwnership(line: string, mine: boolean | undefined, index: number): void {
  if (mine && !isAgentLine(line)) {
    throw new ToolInputError(
      `Line ${index + 1} was written by the user, not you. Leave out "mine" (the change then asks the user first).`,
    );
  }
}

/** Approval-card text for an `edit_note` call. */
export function describeNoteEdit(input: unknown): string {
  const args =
    typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const note = typeof args.notePath === "string" ? args.notePath : "the task's note";
  const edits = Array.isArray(args.edits) ? (args.edits as Array<Record<string, unknown>>) : [];
  const parts = edits.slice(0, 3).map((edit) => {
    const quoted = typeof edit.expect === "string" ? ` ${quote(edit.expect, 60)}` : "";
    switch (edit.op) {
      case "replace":
        return `change${quoted} to ${quote(String(edit.text ?? ""), 60)}`;
      case "delete":
        return `delete${quoted}`;
      case "set_checkbox":
        return `${edit.checked ? "check" : "uncheck"} ${String(edit.taskId ?? "a task")}`;
      default: {
        const n = Array.isArray(edit.lines) ? edit.lines.length : 0;
        return `add ${pluralize(n, "line")}`;
      }
    }
  });
  const more = edits.length > 3 ? ` (+${edits.length - 3} more)` : "";
  return `Edit ${note}: ${parts.join("; ") || "no changes"}${more}`;
}

/**
 * The note tool of the orchestrator and every subagent. `ownTask`: the subagent's task, which
 * edits are about unless they name another. `signAs`: a caller that isn't a line of a note (a
 * routine's run): its edits go to today's note unless they name one, signed with its thread.
 */
export function createNoteEditTool(
  host: NoteEditHost,
  options: { ownTask?: string; signAs?: string } = {},
): ToolSpec {
  return {
    name: TOOL.editNote,
    label: "Edit note",
    description:
      "Write in the user's note. New lines are shown as yours (the agent's) and go in right away: put results where the user looks — a sub-bullet under the task with the key result and its source link, a follow-up task, an answer under a question. Changing or deleting the user's own lines asks them first.",
    parameters: {
      type: "object",
      properties: {
        notePath: {
          type: "string",
          description: "Vault path; defaults to the note of taskId, else today's daily note.",
        },
        taskId: {
          type: "string",
          description:
            "The task or anchor id this edit is about (a subagent's own task by default).",
        },
        edits: {
          type: "array",
          minItems: 1,
          maxItems: MAX_EDITS,
          items: {
            type: "object",
            properties: {
              op: { type: "string", enum: [...NOTE_EDIT_OPS] },
              taskId: {
                type: "string",
                description: "add_under, set_checkbox: task or anchor id.",
              },
              line: {
                type: "integer",
                minimum: 0,
                description:
                  "insert_after, replace, delete: 1-based line (0 = top, insert_after only).",
              },
              expect: {
                type: "string",
                description: "insert_after, replace, delete: the line's current text.",
              },
              lines: {
                type: "array",
                items: { type: "string" },
                maxItems: MAX_LINES_PER_EDIT,
                description: "add_under, insert_after, append: the new lines (markdown).",
              },
              text: { type: "string", description: "replace: the line's new text." },
              checked: { type: "boolean", description: "set_checkbox." },
              mine: {
                type: "boolean",
                description: "replace, delete, set_checkbox: true when you wrote that line.",
              },
            },
            required: ["op"],
            additionalProperties: false,
          },
        },
      },
      required: ["edits"],
      additionalProperties: false,
    },
    safety: { category: "file_write", describe: describeNoteEdit },
    promptGuidelines: [
      "edit_note: keep it short (1-3 lines), cite sources as markdown links, and never repeat what the badge already says.",
    ],
    execute: (input, ctx) =>
      guarded(async () => {
        const ownTask = options.signAs ? undefined : (options.ownTask ?? ctx.taskId ?? undefined);
        const args = parseEditNoteInput(input, ownTask);
        const taskId = args.taskId ?? ownTask ?? null;
        const item = taskId ? host.locate(taskId) : null;
        if (taskId && !item && !args.notePath) {
          throw new ToolInputError(`Unknown task id "${taskId}" (it may have been deleted).`);
        }
        const notePath = notePathOf(args.notePath ?? item?.notePath ?? host.defaultNotePath());
        if (isDrawingPath(notePath)) throw new ToolInputError(drawingRefusal(notePath));
        await host.waitForPause(notePath);
        const threadId = host.threadFor(taskId ?? options.signAs ?? null);
        for (let attempt = 1; ; attempt++) {
          const file = await host.storage.read(notePath);
          if (!file) return errorResult(`Note not found: ${notePath}`);
          if (isDrawingMarkdown(file.content)) return errorResult(drawingRefusal(notePath));
          const plan = planNoteEdits(file.content, args.edits, {
            threadId,
            locate: (id) => {
              const at = host.locate(id);
              return at && at.notePath === notePath ? at : null;
            },
          });
          if (plan.content === file.content) return textResult("Nothing to change.");
          try {
            await host.storage.write(notePath, plan.content, { ifMatch: file.version });
          } catch (error) {
            // Someone saved in between: the edits refer to lines by text, so replan on the new note.
            if (error instanceof ConflictError && attempt < WRITE_ATTEMPTS) continue;
            throw error;
          }
          host.onEdited?.({ notePath, taskId, threadId, lines: plan.written });
          return textResult(`Edited ${notePath}: ${plan.changes.join("; ")}.`, {
            notePath,
            changes: plan.changes,
          });
        }
      }),
  };
}

/** Drawings are the user's: agents look at them (read_drawing) but never write in them. */
function drawingRefusal(notePath: string): string {
  return `${notePath} is a drawing: edit_note writes in notes, never in drawings. Put your lines in the note that embeds it.`;
}

function notePathOf(requested: string): string {
  let path: string;
  try {
    path = normalizePath(requested.replace(/^\[\[|\]\]$/g, ""));
  } catch {
    throw new ToolInputError(`Invalid note path: ${requested}`);
  }
  if (!path || isHiddenPath(path)) throw new ToolInputError(`Not a note: ${requested}`);
  if (!isMarkdownPath(path)) path = `${path}.md`;
  return path;
}

/** `ownTask`: the caller's task (a subagent's), the default for edits that name none. */
function parseEditNoteInput(input: unknown, ownTask: string | undefined): EditNoteInput {
  const args = asInput(input);
  const notePath = optionalString(args, "notePath", { maxLength: 1_000 });
  const taskId = optionalString(args, "taskId", { maxLength: 100 });
  const raw = args.edits;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ToolInputError('"edits" must be a non-empty list of edits.');
  }
  if (raw.length > MAX_EDITS) throw new ToolInputError(`At most ${MAX_EDITS} edits per call.`);
  const edits = raw.map((edit, i) => parseEdit(edit, i, taskId ?? ownTask));
  return { ...(notePath ? { notePath } : {}), ...(taskId ? { taskId } : {}), edits };
}

function parseEdit(raw: unknown, index: number, defaultTask: string | undefined): NoteEdit {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ToolInputError(`edits[${index}] must be an object.`);
  }
  const edit = raw as ToolInput;
  const op: NoteEditOp = requireEnum(edit, "op", NOTE_EDIT_OPS);
  const where = `edits[${index}] (${op})`;
  const out: NoteEdit = { op };
  if (op === "add_under" || op === "set_checkbox") {
    const id =
      typeof edit.taskId === "string" && edit.taskId.trim() ? edit.taskId.trim() : defaultTask;
    if (!id) throw new ToolInputError(`${where} needs "taskId".`);
    out.taskId = id;
  }
  if (op === "insert_after" || op === "replace" || op === "delete") {
    const line = edit.line;
    if (
      typeof line !== "number" ||
      !Number.isInteger(line) ||
      line < (op === "insert_after" ? 0 : 1)
    ) {
      throw new ToolInputError(`${where} needs "line", the 1-based line number.`);
    }
    out.line = line;
    if (line > 0) {
      if (typeof edit.expect !== "string" || edit.expect.trim() === "") {
        throw new ToolInputError(`${where} needs "expect", the line's current text.`);
      }
      out.expect = edit.expect;
    }
  }
  if (op === "add_under" || op === "insert_after" || op === "append") {
    const lines = edit.lines;
    if (!Array.isArray(lines) || lines.length === 0 || !lines.every((l) => typeof l === "string")) {
      throw new ToolInputError(`${where} needs "lines", a non-empty list of strings.`);
    }
    const split = (lines as string[]).flatMap((l) => l.split("\n")).filter((l) => l.trim() !== "");
    if (split.length === 0) throw new ToolInputError(`${where} has only blank lines.`);
    if (split.length > MAX_LINES_PER_EDIT) {
      throw new ToolInputError(`${where}: at most ${MAX_LINES_PER_EDIT} lines per edit.`);
    }
    if (split.some((l) => l.length > MAX_LINE_CHARS)) {
      throw new ToolInputError(`${where}: lines are limited to ${MAX_LINE_CHARS} characters.`);
    }
    out.lines = split;
  }
  if (op === "replace") {
    if (typeof edit.text !== "string" || edit.text.trim() === "" || edit.text.includes("\n")) {
      throw new ToolInputError(`${where} needs "text", the line's new text on one line.`);
    }
    if (edit.text.length > MAX_LINE_CHARS) {
      throw new ToolInputError(`${where}: lines are limited to ${MAX_LINE_CHARS} characters.`);
    }
    out.text = edit.text;
  }
  if (op === "set_checkbox") {
    if (typeof edit.checked !== "boolean") throw new ToolInputError(`${where} needs "checked".`);
    out.checked = edit.checked;
  }
  if (edit.mine === true) out.mine = true;
  return out;
}
