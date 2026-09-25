import { insertNewlineContinueMarkup } from "@codemirror/lang-markdown";
import type { EditorState, TransactionSpec } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { annotationField, setAnnotationsEffect } from "../annotations/field";
import { apply, parsedState, run } from "../test-helpers";
import type { ActivityChip } from "../types";
import { activityChipField, getActivityChips, setActivityChipsEffect } from "./field";
import { ActivityChipWidget, chipClassName } from "./widget";

const DOC = ["# Thursday", "find a plumber for Saturday", "- [ ] email Sam", "Slept badly."].join(
  "\n",
);

function chip(id: string, line: number, extra: Partial<ActivityChip> = {}): ActivityChip {
  return {
    id,
    line,
    label: "Working…",
    tooltip: "The orchestrator is working on it",
    tone: "working",
    ...extra,
  };
}

function withChips(doc: string, chips: ActivityChip[], cursor = 0): EditorState {
  return apply(parsedState(doc, { selection: { anchor: cursor } }), {
    effects: setActivityChipsEffect.of(chips),
  });
}

function lines(state: EditorState): Record<string, number> {
  return Object.fromEntries(getActivityChips(state).map((c) => [c.id, c.line]));
}

/** Chip widgets as [id, 0-based line, drawn at the line end]. */
function drawn(state: EditorState): Array<[string, number, boolean]> {
  const out: Array<[string, number, boolean]> = [];
  state.field(activityChipField).decorations.between(0, state.doc.length, (from, _to, deco) => {
    const widget = (deco.spec as { widget?: unknown }).widget;
    if (widget instanceof ActivityChipWidget) {
      const line = state.doc.lineAt(from);
      out.push([widget.chip.id, line.number - 1, from === line.to]);
    }
  });
  return out;
}

function lineStart(state: EditorState, line: number): number {
  return state.doc.line(line + 1).from;
}

function lineEnd(state: EditorState, line: number): number {
  return state.doc.line(line + 1).to;
}

const edit = (state: EditorState, spec: TransactionSpec) => apply(state, spec);

describe("activity chips", () => {
  it("draws each chip at the end of its line, skipping blank and missing lines", () => {
    const state = withChips(`${DOC}\n\n`, [chip("a", 1), chip("b", 3), chip("c", 4), chip("d", 9)]);
    expect(drawn(state)).toEqual([
      ["a", 1, true],
      ["b", 3, true],
    ]);
  });

  it("follows its line while the user keeps typing it, and through lines added above", () => {
    let state = withChips(DOC, [chip("a", 1)]);
    state = edit(state, { changes: { from: lineEnd(state, 1), insert: " morning, near home" } });
    expect(lines(state)).toEqual({ a: 1 });
    state = edit(state, { changes: { from: 0, insert: "Groceries\nMilk\n" } });
    expect(lines(state)).toEqual({ a: 3 });
    expect(drawn(state)).toEqual([["a", 3, true]]);
  });

  it("stays on its line when Enter is pressed at its end, and moves down with Enter at its start", () => {
    let state = withChips(`- ${DOC}`, [chip("a", 0)], 0);
    state = edit(state, { selection: { anchor: lineEnd(state, 0) } });
    state = run(state, insertNewlineContinueMarkup)!;
    expect(state.doc.line(2).text).toBe("- ");
    expect(drawn(state)).toEqual([["a", 0, true]]);
    state = withChips(DOC, [chip("a", 1)], 0);
    state = edit(state, { changes: { from: lineEnd(state, 1), insert: "\n" } });
    expect(drawn(state)).toEqual([["a", 1, true]]);
    state = edit(state, { changes: { from: lineStart(state, 1), insert: "\n" } });
    expect(drawn(state)).toEqual([["a", 2, true]]);
  });

  it("survives typos fixed and words added, and goes when the line becomes something else", () => {
    let state = withChips(DOC, [chip("a", 1)]);
    const replaceLine = (s: EditorState, text: string) =>
      edit(s, { changes: { from: lineStart(s, 1), to: lineEnd(s, 1), insert: text } });
    state = replaceLine(state, "find a plumbr for Saturday!");
    expect(lines(state)).toEqual({ a: 1 });
    state = replaceLine(state, "please find a plumber for Saturday morning");
    expect(lines(state)).toEqual({ a: 1 });
    state = replaceLine(state, "Call mom about the weekend");
    expect(lines(state)).toEqual({});
  });

  it("goes with its line, when joined away, and when the line is emptied", () => {
    let state = withChips(`${DOC}\nfind a plumber for Saturday`, [chip("a", 1), chip("b", 3)]);
    // Deleted with its break: the next line with the same text doesn't inherit the chip.
    state = edit(state, { changes: { from: lineStart(state, 1), to: lineEnd(state, 1) + 1 } });
    expect(lines(state)).toEqual({ b: 2 });
    const joined = edit(withChips(DOC, [chip("a", 1)]), {
      changes: { from: lineEnd(parsedState(DOC), 0), to: lineEnd(parsedState(DOC), 1) },
    });
    expect(lines(joined)).toEqual({});
    state = edit(state, { changes: { from: lineStart(state, 2) + 5, to: lineEnd(state, 2) } });
    expect(lines(state)).toEqual({ b: 2 });
    state = edit(state, { changes: { from: lineStart(state, 2), to: lineEnd(state, 2) } });
    expect(lines(state)).toEqual({});
  });

  it("ignores edits on other lines", () => {
    let state = withChips(DOC, [chip("a", 1)]);
    state = edit(state, { changes: { from: lineEnd(state, 3), insert: " Long day." } });
    state = edit(state, { changes: { from: lineStart(state, 3), to: lineEnd(state, 3) } });
    expect(lines(state)).toEqual({ a: 1 });
  });

  it("keeps a chip's widget while it doesn't change, and replaces the set on every set", () => {
    let state = withChips(DOC, [chip("a", 1)]);
    const widget = () =>
      state.field(activityChipField).entries.find((e) => e.chip.id === "a")?.widget;
    const first = widget();
    state = edit(state, { effects: setActivityChipsEffect.of([chip("a", 1), chip("b", 3)]) });
    expect(widget()).toBe(first);
    state = edit(state, {
      effects: setActivityChipsEffect.of([chip("a", 1, { label: "Replied ↗", tone: "quiet" })]),
    });
    expect(widget()).not.toBe(first);
    expect(lines(state)).toEqual({ a: 1 });
  });

  it("is drawn after the line's badge", () => {
    let state = withChips(DOC, [chip("a", 2)]);
    state = edit(state, {
      effects: setAnnotationsEffect.of([
        { id: "t", line: 2, status: "triaging", label: "Triaging…", unread: 0, threadId: null },
      ]),
    });
    const sides: string[] = [];
    const collect = (from: number, to: number, deco: { spec: unknown }) => {
      const spec = deco.spec as { widget?: unknown; side?: number };
      if (from === to && spec.widget) sides.push(`${from}:${spec.side}`);
    };
    state.field(annotationField).decorations.between(0, state.doc.length, collect);
    state.field(activityChipField).decorations.between(0, state.doc.length, collect);
    const end = lineEnd(state, 2);
    expect(sides).toEqual([`${end}:1`, `${end}:2`]);
  });
});

describe("activity chip classes", () => {
  it("looks like a badge of its tone, with a dot, pulse and fade", () => {
    expect(chipClassName(chip("a", 0))).toBe(
      "cm-ddl-badge cm-ddl-badge-tone-working cm-ddl-activity-chip",
    );
    expect(chipClassName(chip("a", 0, { label: "", tone: "quiet", pulse: true }))).toBe(
      "cm-ddl-badge cm-ddl-badge-tone-quiet cm-ddl-activity-chip cm-ddl-activity-chip-dot cm-ddl-activity-chip-pulse",
    );
    expect(chipClassName(chip("a", 0, { fading: true }))).toContain("cm-ddl-activity-chip-fading");
  });
});
