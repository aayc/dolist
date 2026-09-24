import { moveLineDown, moveLineUp, redo, undo } from "@codemirror/commands";
import type { EditorState, TransactionSpec } from "@codemirror/state";
import type { TaskAgentStatus } from "@ddl/core";
import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { continueMarkup } from "../commands/lists";
import { fullyParsed, parsedState, run } from "../test-helpers";
import type { LineAnnotation } from "../types";
import { annotationField, getAnnotations, setAnnotationsEffect } from "./field";
import { BadgeWidget } from "./widget";

const TASKS = 30;
const VISIBLE: readonly TaskAgentStatus[] = [
  "triaging",
  "queued",
  "working",
  "waiting_approval",
  "waiting_user",
  "done",
  "failed",
  "cancelled",
];
const ALL_STATUSES: readonly TaskAgentStatus[] = [...VISIBLE, "idle", "ignored"];

/** Unique marker right after each task's checkbox; edits never type `§`, so tokens can't appear. */
const token = (i: number) => `§${String(i).padStart(2, "0")}§`;

const filler = fc.constantFrom("", "# Heading", "plain text", "- bullet", "> quote", "\t- nested");
const insertText = fc.stringMatching(/^[a-z0-9 \-[\]x*#>é😀]{1,6}$/u);
const pasteText = fc.stringMatching(/^[a-z \-[\]x\n]{0,12}$/);

interface Fixture {
  doc: string;
  annotations: LineAnnotation[];
}

const fixture: fc.Arbitrary<Fixture> = fc
  .array(fc.tuple(fc.array(filler, { maxLength: 2 }), fc.constantFrom(" ", "x", "/", "-")), {
    minLength: TASKS,
    maxLength: TASKS,
  })
  .chain((rows) =>
    fc
      .array(fc.constantFrom(...ALL_STATUSES), { minLength: TASKS, maxLength: TASKS })
      .map((statuses) => {
        const lines: string[] = [];
        const annotations: LineAnnotation[] = [];
        rows.forEach(([fillers, status], i) => {
          lines.push(...fillers);
          annotations.push({
            id: `a${i}`,
            line: lines.length,
            status: statuses[i]!,
            label: `label ${i}`,
            unread: i % 3,
            threadId: `thr_${i}`,
          });
          lines.push(`${i % 5 === 0 ? "\t" : ""}- [${status}] ${token(i)} task number ${i}`);
        });
        return { doc: lines.join("\n"), annotations };
      }),
  );

type Op =
  | { kind: "type"; at: number; text: string }
  | { kind: "enter"; at: number }
  | { kind: "enterAtEnd"; line: number }
  | { kind: "delete"; at: number; length: number }
  | { kind: "deleteLine"; line: number }
  | { kind: "joinLine"; line: number }
  | { kind: "paste"; at: number; length: number; text: string }
  | { kind: "moveLine"; line: number; down: boolean }
  | { kind: "replaceAll"; text: string }
  | { kind: "undo" }
  | { kind: "redo" };

const n = fc.nat({ max: 10_000 });
const op: fc.Arbitrary<Op> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ kind: fc.constant("type"), at: n, text: insertText }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("enter"), at: n }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("enterAtEnd"), line: n }) },
  {
    weight: 3,
    arbitrary: fc.record({ kind: fc.constant("delete"), at: n, length: fc.nat({ max: 40 }) }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("deleteLine"), line: n }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("joinLine"), line: n }) },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("paste"),
      at: n,
      length: fc.nat({ max: 20 }),
      text: pasteText,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant("moveLine"), line: n, down: fc.boolean() }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("replaceAll"), text: pasteText }) },
  { weight: 3, arbitrary: fc.constant({ kind: "undo" as const }) },
  { weight: 2, arbitrary: fc.constant({ kind: "redo" as const }) },
);

/**
 * Positions where inserting a line break could split a task between its start (where the badge is
 * anchored) and its token, which by design leaves the badge with the start. A task starts after
 * the previous task's token when lines were joined, so anywhere in `(previous token end, next
 * token start]` is unsafe; the break moves to the previous token's end (or the line start).
 */
function safeBreakPos(state: EditorState, pos: number): number {
  const line = state.doc.lineAt(pos);
  let segmentStart = line.from;
  for (const match of line.text.matchAll(/§\d\d§/g)) {
    const start = line.from + match.index;
    if (pos <= start) return pos <= segmentStart ? pos : segmentStart;
    segmentStart = start + match[0].length;
  }
  return pos;
}

function edit(state: EditorState, spec: TransactionSpec): EditorState {
  return fullyParsed(state.update(spec).state);
}

function applyOp(state: EditorState, o: Op, keepTokenModel: boolean): EditorState {
  const { doc } = state;
  const len = doc.length;
  const lineOf = (i: number) => doc.line((i % doc.lines) + 1);
  switch (o.kind) {
    case "type": {
      const at = o.at % (len + 1);
      return edit(state, {
        changes: { from: at, insert: o.text },
        selection: { anchor: at + o.text.length },
        userEvent: "input.type",
      });
    }
    case "enter": {
      let at = o.at % (len + 1);
      if (keepTokenModel) at = safeBreakPos(state, at);
      return edit(state, {
        changes: { from: at, insert: "\n" },
        selection: { anchor: at + 1 },
        userEvent: "input",
      });
    }
    case "enterAtEnd": {
      const line = lineOf(o.line);
      const atEnd = edit(state, { selection: { anchor: line.to } });
      return fullyParsed(
        run(atEnd, continueMarkup) ??
          atEnd.update({
            changes: { from: line.to, insert: "\n" },
            selection: { anchor: line.to + 1 },
            userEvent: "input",
          }).state,
      );
    }
    case "delete": {
      const from = o.at % (len + 1);
      return edit(state, {
        changes: { from, to: Math.min(len, from + o.length) },
        userEvent: "delete",
      });
    }
    case "deleteLine": {
      const line = lineOf(o.line);
      const from = line.to === len && line.from > 0 ? line.from - 1 : line.from;
      return edit(state, {
        changes: { from, to: Math.min(len, line.to + 1) },
        userEvent: "delete.line",
      });
    }
    case "joinLine": {
      const line = lineOf(o.line);
      if (line.number === doc.lines) return state;
      return edit(state, { changes: { from: line.to, to: line.to + 1 }, userEvent: "delete" });
    }
    case "paste": {
      let from = o.at % (len + 1);
      const to = Math.min(len, from + o.length);
      if (keepTokenModel && o.text.includes("\n")) from = Math.min(safeBreakPos(state, from), to);
      return edit(state, {
        changes: { from, to, insert: o.text },
        selection: { anchor: from + o.text.length },
        userEvent: "input.paste",
      });
    }
    case "moveLine": {
      const line = lineOf(o.line);
      const on = edit(state, { selection: { anchor: line.from } });
      const moved = run(on, o.down ? moveLineDown : moveLineUp);
      return moved ? fullyParsed(moved) : state;
    }
    case "replaceAll":
      return edit(state, {
        changes: { from: 0, to: len, insert: o.text },
        userEvent: "input.paste",
      });
    case "undo":
      return fullyParsed(run(state, undo) ?? state);
    case "redo":
      return fullyParsed(run(state, redo) ?? state);
  }
}

/** Badge widgets and annotated-line classes, as rendered. */
function rendered(state: EditorState) {
  const badges: Array<{ id: string; line: number; atLineEnd: boolean }> = [];
  const lineClasses: number[] = [];
  state.field(annotationField).decorations.between(0, state.doc.length, (from, to, deco) => {
    const spec = deco.spec as { widget?: unknown; class?: string };
    const line = state.doc.lineAt(from);
    if (spec.widget instanceof BadgeWidget) {
      badges.push({
        id: spec.widget.annotation.id,
        line: line.number - 1,
        atLineEnd: from === line.to,
      });
    } else if (spec.class?.startsWith("cm-ddl-annotated") && from === to) {
      lineClasses.push(line.number - 1);
    }
  });
  return { badges, lineClasses };
}

/** Invariants that hold after any edit. Returns the current annotation ids. */
function expectConsistent(state: EditorState, previous: ReadonlySet<string>): Set<string> {
  const annotations = getAnnotations(state);
  const ids = annotations.map((a) => a.id);
  expect(new Set(ids).size, "a badge is never duplicated").toBe(ids.length);
  for (const a of annotations) {
    expect(a.line).toBeGreaterThanOrEqual(0);
    expect(a.line, "badge line in range").toBeLessThan(state.doc.lines);
    expect(previous.has(a.id), `badge ${a.id} never comes back once dropped`).toBe(true);
    expect(a.status === "idle" || a.status === "ignored").toBe(false);
  }
  const entries = state.field(annotationField).entries;
  for (let i = 1; i < entries.length; i++) {
    expect(entries[i]!.anchor).toBeGreaterThanOrEqual(entries[i - 1]!.anchor);
  }
  for (const entry of entries) {
    expect(entry.anchor).toBeGreaterThanOrEqual(0);
    expect(entry.anchor).toBeLessThanOrEqual(state.doc.length);
  }
  const { badges, lineClasses } = rendered(state);
  expect(badges.map((b) => [b.id, b.line])).toEqual(annotations.map((a) => [a.id, a.line]));
  expect(
    badges.every((b) => b.atLineEnd),
    "badges are drawn at the end of their line",
  ).toBe(true);
  expect(lineClasses).toEqual([...new Set(annotations.map((a) => a.line))]);
  return new Set(ids);
}

/** Position of the task's token if it survived intact exactly once. */
function tokenPos(text: string, id: string): number | null {
  const t = token(Number(id.slice(1)));
  const at = text.indexOf(t);
  return at < 0 || text.indexOf(t, at + 1) >= 0 ? null : at;
}

/**
 * A badge whose token survived intact is on the token's line; a badge only disappears when its
 * task's text (token) disappears in that step. Returns the ids still shown.
 */
function expectOnTaskLine(state: EditorState, before: ReadonlySet<string>): Set<string> {
  const text = state.doc.toString();
  const shown = getAnnotations(state);
  for (const a of shown) {
    const at = tokenPos(text, a.id);
    if (at === null) continue;
    expect(state.doc.lineAt(at).number - 1, `badge ${a.id} stays on its task`).toBe(a.line);
  }
  const now = new Set(shown.map((a) => a.id));
  for (const id of before) {
    if (now.has(id)) continue;
    expect(tokenPos(text, id), `badge ${id} dropped although its task is still there`).toBeNull();
  }
  return now;
}

function start({ doc, annotations }: Fixture): EditorState {
  const state = parsedState(doc);
  return fullyParsed(state.update({ effects: setAnnotationsEffect.of(annotations) }).state);
}

describe("annotations under random edit sequences (properties)", () => {
  test.prop([fixture, fc.array(op, { minLength: 1, maxLength: 25 })])(
    "stay unique, in range, consistent with their decorations, and never resurrect",
    (fx, ops) => {
      let state = start(fx);
      let ids = expectConsistent(state, new Set(fx.annotations.map((a) => a.id)));
      for (const o of ops) {
        state = applyOp(state, o, false);
        ids = expectConsistent(state, ids);
      }
    },
  );

  test.prop([fixture, fc.array(op, { minLength: 1, maxLength: 25 })])(
    "follow their task line (split, join, move, paste, undo/redo) or disappear with it",
    (fx, ops) => {
      let state = start(fx);
      let shown = expectOnTaskLine(state, new Set());
      for (const o of ops) {
        state = applyOp(state, o, true);
        shown = expectOnTaskLine(state, shown);
      }
    },
  );

  test.prop([fixture, fc.nat({ max: TASKS - 1 })])(
    "Enter at the end of a task line leaves the badge on the task, not the new line",
    (fx, i) => {
      const state = start(fx);
      const annotation = fx.annotations[i]!;
      if (annotation.status === "idle" || annotation.status === "ignored") return;
      const line = state.doc.line(annotation.line + 1);
      const next = applyOp(state, { kind: "enterAtEnd", line: annotation.line }, true);
      const moved = getAnnotations(next).find((a) => a.id === annotation.id);
      expect(moved?.line).toBe(annotation.line);
      expect(next.doc.line(annotation.line + 1).text).toBe(line.text);
      expect(getAnnotations(next).filter((a) => a.line === annotation.line + 1)).toEqual([]);
    },
  );

  test.prop([
    fixture,
    fc.array(op, { maxLength: 10 }),
    fc.array(
      fc.record({
        id: fc.constantFrom("a1", "a2", "a3", "a4", "a5", "new1", "new2"),
        line: fc.integer({ min: -2, max: 90 }),
        status: fc.constantFrom(...ALL_STATUSES),
        unread: fc.nat({ max: 120 }),
      }),
      { maxLength: 8 },
    ),
  ])("setAnnotations replaces the whole set", (fx, ops, specs) => {
    let state = start(fx);
    for (const o of ops) state = applyOp(state, o, false);
    const seen = new Set<string>();
    const next: LineAnnotation[] = [];
    for (const s of specs) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      next.push({ ...s, label: `L ${s.id}`, threadId: null });
    }
    state = fullyParsed(state.update({ effects: setAnnotationsEffect.of(next) }).state);
    const expected = next
      .filter((a) => a.status !== "idle" && a.status !== "ignored")
      .filter((a) => a.line >= 0 && a.line < state.doc.lines)
      .sort((a, b) => a.line - b.line);
    expect(getAnnotations(state)).toEqual(expected);
    expectConsistent(state, new Set(expected.map((a) => a.id)));
  });
});
