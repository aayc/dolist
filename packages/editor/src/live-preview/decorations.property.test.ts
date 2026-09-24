import { syntaxTree } from "@codemirror/language";
import type { EditorSelection, EditorState, SelectionRange } from "@codemirror/state";
import type { Decoration, DecorationSet } from "@codemirror/view";
import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import {
  arbitraryRangesIn,
  markdownDoc,
  type SelectionSpec,
  selectionIn,
  textOf,
  toSelection,
  visibleRangesIn,
} from "../test-arbitraries";
import { parsedState } from "../test-helpers";
import { buildLivePreviewDecorations, type VisibleRange } from "./decorations";

type Kind = "line" | "mark" | "replace";

interface Deco {
  from: number;
  to: number;
  kind: Kind;
  deco: Decoration;
}

type SyntaxNode = ReturnType<typeof syntaxTree>["topNode"];

/** The live preview only creates replacing widgets, so any widget (or class-less spec) replaces. */
function kindOf(from: number, to: number, deco: Decoration): Kind {
  const spec = deco.spec as { widget?: unknown; class?: string };
  if (spec.widget !== undefined || spec.class === undefined) return "replace";
  return from === to ? "line" : "mark";
}

function list(set: DecorationSet): Deco[] {
  const out: Deco[] = [];
  for (const cursor = set.iter(); cursor.value; cursor.next()) {
    out.push({
      from: cursor.from,
      to: cursor.to,
      deco: cursor.value,
      kind: kindOf(cursor.from, cursor.to, cursor.value),
    });
  }
  return out;
}

const ids = new WeakMap<Decoration, number>();
let nextId = 1;
function key({ from, to, deco }: Deco): string {
  let id = ids.get(deco);
  if (id === undefined) {
    id = nextId++;
    ids.set(deco, id);
  }
  return `${from}:${to}:${id}`;
}

function build(state: EditorState, ranges: readonly VisibleRange[], focused: boolean): Deco[] {
  return list(buildLivePreviewDecorations(state, ranges, focused));
}

function touches(selection: readonly SelectionRange[], from: number, to: number): boolean {
  return selection.some((r) => r.from <= to && r.to >= from);
}

function overlaps(a: { from: number; to: number }, from: number, to: number): boolean {
  return a.from < to && from < a.to;
}

/** Structural requirements CodeMirror places on plugin decorations, plus our own. */
function expectWellFormed(state: EditorState, decos: readonly Deco[]): void {
  const { doc } = state;
  let previous = -1;
  for (const d of decos) {
    expect(d.from).toBeGreaterThanOrEqual(0);
    expect(d.to).toBeLessThanOrEqual(doc.length);
    expect(d.from, "sorted by position").toBeGreaterThanOrEqual(previous);
    previous = d.from;
    if (d.kind === "line") {
      expect(d.from, "line decoration at a line start").toBe(doc.lineAt(d.from).from);
    }
    if (d.kind === "mark") expect(d.to).toBeGreaterThan(d.from);
    if (d.kind === "replace") {
      expect(d.to, "replaced ranges are not empty").toBeGreaterThan(d.from);
      expect(doc.sliceString(d.from, d.to), "a plugin may not replace a line break").not.toContain(
        "\n",
      );
    }
  }
  const replaces = decos.filter((d) => d.kind === "replace");
  for (let i = 1; i < replaces.length; i++) {
    expect(replaces[i]!.from, "replaced ranges never overlap").toBeGreaterThanOrEqual(
      replaces[i - 1]!.to,
    );
  }
}

const MARK_CHILDREN: Record<string, readonly string[]> = {
  Emphasis: ["EmphasisMark"],
  StrongEmphasis: ["EmphasisMark"],
  Strikethrough: ["StrikethroughMark"],
  Highlight: ["HighlightMark"],
  InlineCode: ["CodeMark"],
  Autolink: ["LinkMark"],
};

const SOURCE_ONLY = new Set([
  "Table",
  "HTMLBlock",
  "CommentBlock",
  "LinkReference",
  "Image",
  "CodeText",
  "CodeInfo",
]);

function children(node: SyntaxNode, names: readonly string[]): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (names.includes(child.name)) out.push(child);
  }
  return out;
}

function inBlockquote(node: SyntaxNode): boolean {
  for (let p = node.parent; p; p = p.parent) if (p.name === "Blockquote") return true;
  return false;
}

/**
 * Walks the syntax tree independently of the builder and checks the reveal rules: syntax that the
 * selection touches is never hidden, and source-only blocks (code, tables, HTML) are never hidden.
 */
function expectRevealed(
  state: EditorState,
  selection: EditorSelection,
  ranges: readonly VisibleRange[],
  decos: readonly Deco[],
): void {
  const { doc } = state;
  const sel = selection.ranges;
  const replaces = decos.filter((d) => d.kind === "replace");
  const covered = (from: number, to: number) => replaces.some((r) => overlaps(r, from, to));
  const lineTouched = (pos: number) => {
    const line = doc.lineAt(pos);
    return touches(sel, line.from, line.to);
  };
  const check = (node: SyntaxNode): void => {
    const { name } = node;
    const marks = MARK_CHILDREN[name];
    if (marks && touches(sel, node.from, node.to)) {
      for (const mark of children(node, marks)) {
        expect(covered(mark.from, mark.to), `${name} syntax revealed`).toBe(false);
      }
    }
    if (name === "WikiLink" && touches(sel, node.from, node.to)) {
      expect(covered(node.from, node.to), "touched wikilink fully revealed").toBe(false);
    }
    if (name === "Escape" && touches(sel, node.from, node.to)) {
      expect(covered(node.from, node.from + 1), "touched escape revealed").toBe(false);
    }
    if (name === "Link" && touches(sel, node.from, node.to)) {
      const [open, close] = children(node, ["LinkMark"]);
      const textFrom = open?.to ?? node.from;
      const textTo = close?.from ?? node.to;
      for (const r of replaces) {
        if (!overlaps(r, node.from, node.to)) continue;
        // Only syntax nested in the link text (e.g. emphasis) may still be hidden.
        expect(r.from >= textFrom && r.to <= textTo, "touched link syntax revealed").toBe(true);
      }
    }
    if (name.startsWith("ATXHeading") && lineTouched(node.from)) {
      for (const mark of children(node, ["HeaderMark"])) {
        expect(covered(mark.from, mark.to), "heading marks revealed on the active line").toBe(
          false,
        );
      }
    }
    if ((name === "QuoteMark" || name === "HorizontalRule") && lineTouched(node.from)) {
      expect(covered(node.from, node.to), `${name} revealed on the active line`).toBe(false);
    }
    if (name === "ListItem") {
      const mark = node.firstChild;
      const task = mark?.nextSibling;
      const marker = task?.name === "Task" ? task.firstChild : null;
      if (mark?.name === "ListMark") {
        const isTask = marker?.name === "TaskMarker";
        const bullet = node.parent?.name === "BulletList";
        const from = isTask && !bullet ? marker!.from : mark.from;
        const to = isTask ? marker!.to : mark.to;
        if (touches(sel, from, to)) {
          expect(covered(from, to), "touched list marker revealed").toBe(false);
        }
      }
    }
    if (SOURCE_ONLY.has(name) && !inBlockquote(node)) {
      expect(covered(node.from, node.to), `${name} is shown as source`).toBe(false);
    }
  };
  const tree = syntaxTree(state);
  for (const { from, to } of ranges) {
    tree.iterate({
      from,
      to,
      enter: (ref) => {
        check(ref.node);
      },
    });
  }
}

const doc = markdownDoc(30);

/** A document, a selection and a viewport shaped like CodeMirror's (all plain data). */
const scenario: fc.Arbitrary<[string, SelectionSpec, VisibleRange[]]> = doc.chain((text) =>
  fc.tuple(fc.constant(text), selectionIn(text.length), visibleRangesIn(textOf(text))),
);

function stateFor(text: string, selection: SelectionSpec): EditorState {
  return parsedState(text, { selection: toSelection(selection) });
}

describe("live preview decorations (properties)", () => {
  test.prop([scenario])(
    "are well formed for random markdown, selections and viewports",
    ([text, selection, ranges]) => {
      const state = stateFor(text, selection);
      expectWellFormed(state, build(state, ranges, true));
      expectWellFormed(state, build(state, ranges, false));
    },
  );

  test.prop([scenario])(
    "never hide anything the selection touches, and reveal the touched element's syntax",
    ([text, selection, ranges]) => {
      const state = stateFor(text, selection);
      const decos = build(state, ranges, true);
      for (const d of decos) {
        if (d.kind !== "replace") continue;
        expect(
          touches(state.selection.ranges, d.from, d.to),
          "replaced range touches the selection",
        ).toBe(false);
      }
      expectRevealed(state, state.selection, ranges, decos);
    },
  );

  test.prop([scenario.chain((s) => fc.tuple(fc.constant(s), selectionIn(s[0].length)))])(
    "unfocused editors render everything, whatever the selection",
    ([[text, selection, ranges], other]) => {
      const a = stateFor(text, selection);
      const b = a.update({ selection: toSelection(other) }).state;
      expect(build(a, ranges, false).map(key)).toEqual(build(b, ranges, false).map(key));
    },
  );

  test.prop([scenario])(
    "revealing only removes hidden syntax and rendered link styling",
    ([text, selection, ranges]) => {
      const state = stateFor(text, selection);
      const focused = build(state, ranges, true);
      const unfocused = build(state, ranges, false);
      const remaining = new Map<string, number>();
      for (const d of unfocused) remaining.set(key(d), (remaining.get(key(d)) ?? 0) + 1);
      for (const d of focused) {
        const count = remaining.get(key(d)) ?? 0;
        expect(count, "focused decorations are a subset of unfocused ones").toBeGreaterThan(0);
        remaining.set(key(d), count - 1);
      }
      for (const d of unfocused) {
        const count = remaining.get(key(d)) ?? 0;
        if (count === 0) continue;
        remaining.set(key(d), count - 1);
        const cls = (d.deco.spec as { class?: string }).class;
        expect(d.kind === "replace" || cls === "cm-ddl-link" || cls === "cm-ddl-wikilink").toBe(
          true,
        );
      }
    },
  );

  test.prop([
    doc.chain((text) => fc.tuple(fc.constant(text), arbitraryRangesIn(text.length))),
    fc.boolean(),
  ])("never throw for arbitrary (not line-aligned) visible ranges", ([text, ranges], focused) => {
    const state = parsedState(text, { selection: { anchor: Math.floor(text.length / 2) } });
    for (const d of build(state, ranges, focused)) {
      if (d.kind === "replace") expect(state.doc.sliceString(d.from, d.to)).not.toContain("\n");
    }
  });

  test.prop([doc])("decorate read-only editors the same way", (text) => {
    const ranges = [{ from: 0, to: text.length }];
    const shape = (decos: Deco[]) => decos.map((d) => `${d.from}:${d.to}:${d.kind}`);
    expect(shape(build(parsedState(text, { config: { readOnly: true } }), ranges, false))).toEqual(
      shape(build(parsedState(text), ranges, false)),
    );
  });
});
