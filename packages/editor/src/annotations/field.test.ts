import { moveLineDown, moveLineUp, undo } from "@codemirror/commands";
import { insertNewlineContinueMarkup } from "@codemirror/lang-markdown";
import type { EditorState, TransactionSpec } from "@codemirror/state";
import type { TaskAgentStatus } from "@ddl/core";
import { describe, expect, it } from "vitest";
import { apply, parsedState, run } from "../test-helpers";
import type { LineAnnotation } from "../types";
import { annotationAtLine, annotationField, getAnnotations, setAnnotationsEffect } from "./field";
import { BadgeWidget } from "./widget";

const DOC = ["# Today", "- [ ] book flights", "- [ ] email Sam", "notes"].join("\n");

function annotation(id: string, line: number, status: TaskAgentStatus = "working"): LineAnnotation {
  return { id, line, status, label: `${id} label`, unread: 0, threadId: `thread-${id}` };
}

function withAnnotations(doc: string, annotations: LineAnnotation[], cursor = 0): EditorState {
  const state = parsedState(doc, { selection: { anchor: cursor } });
  return apply(state, { effects: setAnnotationsEffect.of(annotations) });
}

function lines(state: EditorState): Record<string, number> {
  return Object.fromEntries(getAnnotations(state).map((a) => [a.id, a.line]));
}

/** Badge widgets as [0-based line, position is the line end]. */
function badges(state: EditorState): Array<[string, number, boolean]> {
  const out: Array<[string, number, boolean]> = [];
  state.field(annotationField).decorations.between(0, state.doc.length, (from, _to, deco) => {
    const widget = (deco.spec as { widget?: unknown }).widget;
    if (widget instanceof BadgeWidget) {
      const line = state.doc.lineAt(from);
      out.push([widget.annotation.id, line.number - 1, from === line.to]);
    }
  });
  return out;
}

function edit(state: EditorState, spec: TransactionSpec): EditorState {
  return apply(state, spec);
}

describe("annotations", () => {
  it("renders badges at the end of their lines with a status line class", () => {
    const state = withAnnotations(DOC, [
      annotation("b", 2, "waiting_approval"),
      annotation("a", 1),
    ]);
    expect(badges(state)).toEqual([
      ["a", 1, true],
      ["b", 2, true],
    ]);
    const classes: string[] = [];
    state.field(annotationField).decorations.between(0, state.doc.length, (from, to, deco) => {
      const spec = deco.spec as { class?: string };
      if (from === to && spec.class)
        classes.push(`${state.doc.lineAt(from).number - 1}:${spec.class}`);
    });
    expect(classes).toEqual([
      "1:cm-ddl-annotated cm-ddl-annotated-working",
      "2:cm-ddl-annotated cm-ddl-annotated-waiting_approval",
    ]);
  });

  it("skips idle/ignored annotations and lines outside the document", () => {
    const state = withAnnotations(DOC, [
      annotation("idle", 1, "idle"),
      annotation("ignored", 2, "ignored"),
      annotation("negative", -1),
      annotation("past-end", 4),
      annotation("fraction", 1.5),
      annotation("ok", 3, "done"),
    ]);
    expect(lines(state)).toEqual({ ok: 3 });
  });

  it("follows the line when text is inserted or deleted above it", () => {
    let state = withAnnotations(DOC, [annotation("a", 1), annotation("b", 2)]);
    state = edit(state, { changes: { from: 0, insert: "intro\n\n" } });
    expect(lines(state)).toEqual({ a: 3, b: 4 });
    state = edit(state, { changes: { from: 0, to: "intro\n\n# Today\n".length } });
    expect(lines(state)).toEqual({ a: 0, b: 1 });
    expect(badges(state).every(([, , atEnd]) => atEnd)).toBe(true);
  });

  it("stays at the end of the line while typing on it", () => {
    let state = withAnnotations(DOC, [annotation("a", 1)]);
    const line = state.doc.line(2);
    state = edit(state, { changes: { from: line.to, insert: " tomorrow" } });
    state = edit(state, { changes: { from: line.from + 6, insert: "cheap " } });
    state = edit(state, { changes: { from: line.from, insert: "\t" } });
    expect(state.doc.line(2).text).toBe("\t- [ ] cheap book flights tomorrow");
    expect(badges(state)).toEqual([["a", 1, true]]);
  });

  it("stays on the task when Enter at its end creates the next task", () => {
    let state = withAnnotations(DOC, [annotation("a", 1)], DOC.indexOf("flights") + 7);
    state = run(state, insertNewlineContinueMarkup) ?? state;
    expect(state.doc.line(3).text).toBe("- [ ] ");
    expect(badges(state)).toEqual([["a", 1, true]]);
  });

  it("moves down with the task when Enter is pressed at its start", () => {
    let state = withAnnotations(DOC, [annotation("a", 1)]);
    state = edit(state, { changes: { from: state.doc.line(2).from, insert: "\n" } });
    expect(lines(state)).toEqual({ a: 2 });
  });

  it("stays on the task when the line is split in the middle", () => {
    let state = withAnnotations(DOC, [annotation("a", 1)]);
    state = edit(state, { changes: { from: DOC.indexOf(" flights"), insert: "\n" } });
    expect(lines(state)).toEqual({ a: 1 });
    expect(badges(state)).toEqual([["a", 1, true]]);
  });

  it("disappears when its line is deleted (Shift-Mod-k, vim dd, cut line)", () => {
    let state = withAnnotations(DOC, [annotation("a", 1), annotation("b", 2)]);
    const line = state.doc.line(2);
    state = edit(state, {
      changes: { from: line.from, to: line.to + 1 },
      userEvent: "delete.line",
    });
    expect(lines(state)).toEqual({ b: 1 });
  });

  it("disappears when the last line is deleted with its preceding newline", () => {
    let state = withAnnotations(DOC, [annotation("a", 3, "done")]);
    const last = state.doc.line(4);
    state = edit(state, { changes: { from: last.from - 1, to: last.to } });
    expect(lines(state)).toEqual({});
  });

  it("disappears when the line's whole content is replaced", () => {
    let state = withAnnotations(DOC, [annotation("a", 1)]);
    const line = state.doc.line(2);
    state = edit(state, { changes: { from: line.from, to: line.to, insert: "something else" } });
    expect(lines(state)).toEqual({});
  });

  it("survives outdenting and being joined to the previous line", () => {
    let state = withAnnotations("- parent\n\t- [ ] child", [annotation("a", 1)]);
    state = edit(state, {
      changes: { from: state.doc.line(2).from, to: state.doc.line(2).from + 1 },
    });
    expect(lines(state)).toEqual({ a: 1 });
    state = edit(state, { changes: { from: state.doc.line(1).to, to: state.doc.line(2).from } });
    expect(state.doc.toString()).toBe("- parent- [ ] child");
    expect(badges(state)).toEqual([["a", 0, true]]);
  });

  it("moves with the line when lines are reordered", () => {
    const initial = withAnnotations(DOC, [annotation("a", 1)], DOC.indexOf("book"));
    const moved = run(initial, moveLineDown);
    expect(moved?.doc.line(3).text).toBe("- [ ] book flights");
    expect(moved && lines(moved)).toEqual({ a: 2 });
  });

  it("keeps the badge of the neighbour a moved line swaps with, also after undo", () => {
    const initial = withAnnotations(DOC, [annotation("a", 1), annotation("b", 2)]);
    const down = run(edit(initial, { selection: { anchor: DOC.indexOf("book") } }), moveLineDown);
    expect(down?.doc.line(2).text).toBe("- [ ] email Sam");
    expect(down && lines(down)).toEqual({ a: 2, b: 1 });
    expect(down && badges(down).every(([, , atEnd]) => atEnd)).toBe(true);
    const undone = down && run(down, undo);
    expect(undone?.doc.toString()).toBe(DOC);
    expect(undone && lines(undone)).toEqual({ a: 1, b: 2 });

    const up = run(edit(initial, { selection: { anchor: DOC.indexOf("email") } }), moveLineUp);
    expect(up && lines(up)).toEqual({ a: 2, b: 1 });
  });

  it("moves with the task text when a replacement at the line start inserts a line break", () => {
    // Select the start of the line (here the bullet) and paste text ending in a line break.
    let state = withAnnotations(DOC, [annotation("a", 1)]);
    const line = state.doc.line(2);
    state = edit(state, { changes: { from: line.from, to: line.from + 1, insert: "new\n" } });
    expect(state.doc.line(3).text).toBe(" [ ] book flights");
    expect(lines(state)).toEqual({ a: 2 });
  });

  it("replaces the whole set and reuses widgets for unchanged annotations", () => {
    let state = withAnnotations(DOC, [annotation("a", 1), annotation("b", 2)]);
    const before = state.field(annotationField).entries.find((e) => e.annotation.id === "a");
    state = edit(state, {
      effects: setAnnotationsEffect.of([annotation("a", 1), annotation("c", 3, "failed")]),
    });
    const after = state.field(annotationField).entries.find((e) => e.annotation.id === "a");
    expect(lines(state)).toEqual({ a: 1, c: 3 });
    expect(after?.widget).toBe(before?.widget);
    state = edit(state, { effects: setAnnotationsEffect.of([]) });
    expect(badges(state)).toEqual([]);
  });

  it("finds the annotation shown on a line", () => {
    const state = withAnnotations(DOC, [annotation("a", 1)]);
    expect(annotationAtLine(state, 1)?.id).toBe("a");
    expect(annotationAtLine(state, 2)).toBeNull();
    expect(annotationAtLine(state, 99)).toBeNull();
  });

  it("compares widgets by content", () => {
    const a = new BadgeWidget(annotation("a", 1));
    expect(a.eq(new BadgeWidget(annotation("a", 5)))).toBe(true);
    expect(a.eq(new BadgeWidget({ ...annotation("a", 1), unread: 2 }))).toBe(false);
    expect(a.eq(new BadgeWidget({ ...annotation("a", 1), status: "done" }))).toBe(false);
  });
});
