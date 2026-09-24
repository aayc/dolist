import type { EditorState, Transaction } from "@codemirror/state";
import { fc, test } from "@fast-check/vitest";
import { describe, expect, vi } from "vitest";
import { matchTaskLine } from "../task-lines";
import { selectionIn, TASK_STATUSES, toSelection } from "../test-arbitraries";
import { parsedState, run } from "../test-helpers";
import { selectedLines, toggleChecklist, toggleTaskAtLine } from "./tasks";

const line = fc.oneof(
  fc
    .tuple(
      fc.constantFrom("", "\t", "  ", "> ", "> > ", "\t> "),
      fc.constantFrom("-", "*", "+", "1.", "2)"),
      fc.constantFrom(...TASK_STATUSES),
      fc.constantFrom("", "text", "call [[Sam]] #todo", "日本 😀"),
    )
    .map(([indent, marker, status, text]) => `${indent}${marker} [${status}] ${text}`),
  fc
    .tuple(
      fc.constantFrom("", "\t", "> "),
      fc.constantFrom("- ", "* ", "1. "),
      fc.constantFrom("item", ""),
    )
    .map(([indent, marker, text]) => `${indent}${marker}${text}`),
  fc.constantFrom(
    "plain text",
    "\tindented",
    "",
    "   ",
    "# Heading",
    "-",
    "- [ ]",
    "[ ] not a task",
  ),
);

const doc = fc.array(line, { minLength: 1, maxLength: 8 }).map((lines) => lines.join("\n"));

/** Line text without its list/task prefix (a box only counts after a list marker). */
function content(text: string): string {
  return text.replace(
    /^[ \t]*(?:>[ \t]?)*[ \t]*(?:(?:[-*+]|\d{1,9}[.)])(?:[ \t]+(?:\[.\](?:[ \t]|$))?|$))?[ \t]*/,
    "",
  );
}

function toggled(status: string): string {
  return status === "x" || status === "X" ? " " : "x";
}

describe("toggleChecklist (properties)", () => {
  test.prop([doc.chain((d) => fc.tuple(fc.constant(d), selectionIn(d.length)))])(
    "toggles exactly the selected lines, keeps their text and never touches other lines",
    ([text, spec]) => {
      const state = parsedState(text, { selection: toSelection(spec) });
      const lines = selectedLines(state);
      const next = run(state, toggleChecklist);
      if (!next) {
        // Declines only when every selected line is blank in a multi-line selection.
        expect(lines.length).toBeGreaterThan(1);
        expect(lines.every((l) => l.text.trim() === "")).toBe(true);
        return;
      }
      expect(next.doc.lines).toBe(state.doc.lines);
      const selected = new Set(lines.map((l) => l.number));
      for (let n = 1; n <= state.doc.lines; n++) {
        const before = state.doc.line(n).text;
        const after = next.doc.line(n).text;
        if (!selected.has(n)) {
          expect(after, `line ${n} untouched`).toBe(before);
          continue;
        }
        const task = matchTaskLine(before);
        if (task) {
          expect(matchTaskLine(after)?.statusChar).toBe(toggled(task.statusChar));
          expect(after.length).toBe(before.length);
        } else if (before.trim() === "" && selected.size > 1) {
          expect(after).toBe(before);
        } else {
          expect(matchTaskLine(after)?.statusChar, JSON.stringify(before)).toBe(" ");
        }
        expect(content(after)).toBe(content(before));
      }
    },
  );

  const taskDoc = doc.map((text) =>
    text
      .split("\n")
      .map((l) => (matchTaskLine(l) ? l.replace(/\[.\]/, "[ ]") : "- [x] task"))
      .join("\n"),
  );

  test.prop([taskDoc.chain((d) => fc.tuple(fc.constant(d), selectionIn(d.length)))])(
    "is an involution on lines that are already [ ]/[x] tasks",
    ([text, spec]) => {
      const state = parsedState(text, { selection: toSelection(spec) });
      const twice = run(run(state, toggleChecklist)!, toggleChecklist);
      expect(twice?.doc.toString()).toBe(text);
      expect(twice?.selection.eq(state.selection)).toBe(true);
    },
  );

  test.prop([fc.constantFrom("buy milk", "\tindented", "> quoted", "- item", "1. step")])(
    "turns text into an unchecked task, then alternates [x] ↔ [ ]",
    (text) => {
      let state: EditorState = parsedState(text, { selection: { anchor: text.length } });
      const statuses: string[] = [];
      for (let i = 0; i < 4; i++) {
        state = run(state, toggleChecklist)!;
        statuses.push(matchTaskLine(state.doc.toString())?.statusChar ?? "none");
      }
      expect(statuses).toEqual([" ", "x", " ", "x"]);
      expect(content(state.doc.toString())).toBe(content(text));
    },
  );
});

describe("toggleTaskAtLine (properties)", () => {
  test.prop([doc, fc.oneof(fc.integer({ min: -3, max: 12 }), fc.double({ noNaN: false }))])(
    "toggles only the status character of task lines and rejects anything else",
    (text, lineIndex) => {
      let state = parsedState(text);
      const dispatch = vi.fn((tr: Transaction) => {
        state = tr.state;
      });
      const before = state;
      const valid = Number.isInteger(lineIndex) && lineIndex >= 0 && lineIndex < before.doc.lines;
      const task = valid ? matchTaskLine(before.doc.line(lineIndex + 1).text) : null;
      const handled = toggleTaskAtLine({ state: before, dispatch }, lineIndex);
      expect(handled).toBe(task !== null);
      expect(dispatch).toHaveBeenCalledTimes(task ? 1 : 0);
      if (!task) return;
      const changedLine = state.doc.line(lineIndex + 1).text;
      expect(matchTaskLine(changedLine)?.statusChar).toBe(toggled(task.statusChar));
      expect(state.doc.length).toBe(before.doc.length);
      for (let n = 1; n <= before.doc.lines; n++) {
        if (n !== lineIndex + 1) expect(state.doc.line(n).text).toBe(before.doc.line(n).text);
      }
      expect(dispatch.mock.calls[0]![0].isUserEvent("input.toggle")).toBe(true);
    },
  );

  test.prop([doc, fc.nat({ max: 10 })])(
    "never dispatches in a read-only editor",
    (text, lineIndex) => {
      const state = parsedState(text, { config: { readOnly: true } });
      const dispatch = vi.fn();
      expect(toggleTaskAtLine({ state, dispatch }, lineIndex)).toBe(false);
      expect(run(state, toggleChecklist)).toBeNull();
      expect(dispatch).not.toHaveBeenCalled();
    },
  );
});
