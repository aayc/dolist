// @vitest-environment happy-dom
import { undo, undoDepth } from "@codemirror/commands";
import { EditorSelection, EditorState } from "@codemirror/state";
import { fc, test } from "@fast-check/vitest";
import { afterAll, beforeAll, describe, expect, vi } from "vitest";
import { getAnnotations } from "./annotations/field";
import { normalizeLineEndings } from "./diff";
import { createMarkdownEditor } from "./editor";
import { markdownDoc } from "./test-arbitraries";
import { DEFAULT_EDITOR_CONFIG, type EditorConfig, type MarkdownEditor } from "./types";

const onDocChange = vi.fn();
let editor: MarkdownEditor;

beforeAll(() => {
  const parent = document.createElement("div");
  document.body.append(parent);
  editor = createMarkdownEditor(parent, { doc: "", callbacks: { onDocChange } });
});

afterAll(() => editor.destroy());

/** Lines with unique prefixes, so an external edit's position is never ambiguous. */
const uniqueLines = fc
  .array(fc.constantFrom("- [ ] task", "text", "", "## Head", "> q", "- [x] done 😀"), {
    minLength: 3,
    maxLength: 12,
  })
  .map((lines) => lines.map((text, i) => `L${i} ${text}`));

type ExternalEdit =
  | { kind: "insertLines"; at: number; count: number }
  | { kind: "deleteLines"; from: number; to: number }
  | { kind: "editLine"; line: number; text: string };

const externalEdit: fc.Arbitrary<ExternalEdit> = fc.oneof(
  fc.record({
    kind: fc.constant("insertLines"),
    at: fc.nat(),
    count: fc.integer({ min: 1, max: 3 }),
  }),
  fc.record({ kind: fc.constant("deleteLines"), from: fc.nat(), to: fc.nat() }),
  fc.record({
    kind: fc.constant("editLine"),
    line: fc.nat(),
    text: fc.constantFrom("", "changed", "- [x] done", "日本"),
  }),
);

/** Applies an edit that never touches line `keep`; returns the new lines and where `keep` went. */
function applyEdit(lines: string[], keep: number, edit: ExternalEdit): [string[], number] {
  const out = lines.slice();
  switch (edit.kind) {
    case "insertLines": {
      const at = edit.at % (lines.length + 1);
      const added = Array.from({ length: edit.count }, (_, i) => `N${i} new remote line`);
      out.splice(at, 0, ...added);
      return [out, at <= keep ? keep + edit.count : keep];
    }
    case "deleteLines": {
      let from = edit.from % lines.length;
      let to = edit.to % lines.length;
      if (from > to) [from, to] = [to, from];
      if (keep >= from && keep <= to) return [out, keep];
      out.splice(from, to - from + 1);
      return [out, keep > to ? keep - (to - from + 1) : keep];
    }
    case "editLine": {
      const line = edit.line % lines.length;
      if (line === keep) return [out, keep];
      out[line] = `${lines[line]!.split(" ")[0]} ${edit.text}`;
      return [out, keep];
    }
  }
}

describe("setDocument (properties)", () => {
  test.prop([
    uniqueLines.chain((lines) =>
      fc.tuple(
        fc.constant(lines),
        fc.nat({ max: lines.length - 1 }),
        fc.nat(),
        fc.array(externalEdit, { minLength: 1, maxLength: 4 }),
      ),
    ),
  ])(
    "keeps the caret on the same text for edits elsewhere, outside the undo history",
    ([lines, caretLine, column, edits]) => {
      editor.setDocument(lines.join("\n"), { resetHistory: true });
      const line = editor.view.state.doc.line(caretLine + 1);
      const col = column % (line.length + 1);
      editor.view.dispatch({ selection: { anchor: line.from + col } });
      editor.view.dispatch({ changes: { from: line.to, insert: "!" }, userEvent: "input.type" });
      let current = editor.getDocument().split("\n");
      let keep = caretLine;
      onDocChange.mockClear();
      for (const edit of edits) {
        [current, keep] = applyEdit(current, keep, edit);
        editor.setDocument(current.join("\n"));
        expect(editor.getDocument()).toBe(current.join("\n"));
        const { state } = editor.view;
        const head = state.doc.lineAt(state.selection.main.head);
        expect(head.number - 1, "caret line").toBe(keep);
        expect(state.selection.main.head - head.from, "caret column").toBe(col);
      }
      for (const [, meta] of onDocChange.mock.calls) expect(meta).toEqual({ userEvent: false });
      // Undo reverts the local "!" only; the external edits stay.
      undo(editor.view);
      expect(editor.getDocument()).toBe(current.join("\n").replace("!", ""));
    },
  );

  test.prop([markdownDoc(10), fc.constantFrom("\r\n", "\r", "\n")])(
    "normalizes line endings and treats an equivalent document as a no-op",
    (doc, eol) => {
      editor.setDocument(doc, { resetHistory: true });
      onDocChange.mockClear();
      editor.setDocument(doc.replace(/\n/g, eol));
      expect(editor.getDocument()).toBe(doc);
      expect(onDocChange).not.toHaveBeenCalled();
    },
  );
});

const partialConfig: fc.Arbitrary<Partial<EditorConfig>> = fc.record(
  {
    livePreview: fc.boolean(),
    readOnly: fc.boolean(),
    readableLineLength: fc.boolean(),
    showLineNumbers: fc.boolean(),
    fontSize: fc.integer({ min: 4, max: 90 }),
  },
  { requiredKeys: [] },
);

describe("createState / setState (properties)", () => {
  test.prop([markdownDoc(10).map((d) => d.replace(/\n/g, "\r\n"))])(
    "createState normalizes line endings and starts without history or badges",
    (doc) => {
      const state = editor.createState(doc);
      expect(state.doc.toString()).toBe(normalizeLineEndings(doc));
      editor.setState(state);
      expect(editor.getDocument()).toBe(normalizeLineEndings(doc));
      expect(undoDepth(editor.view.state)).toBe(0);
      expect(getAnnotations(editor.view.state)).toEqual([]);
    },
  );

  test.prop([markdownDoc(8), markdownDoc(8), fc.array(partialConfig, { maxLength: 3 }), fc.nat()])(
    "switching away and back restores document, selection and undo history under the current config",
    (docA, docB, configs, caret) => {
      editor.configure(DEFAULT_EDITOR_CONFIG);
      editor.setState(editor.createState(docA));
      const at = caret % (docA.length + 1);
      editor.view.dispatch({ selection: { anchor: at } });
      editor.view.dispatch({ changes: { from: at, insert: "typed" }, userEvent: "input.type" });
      editor.setAnnotations([
        { id: "t", line: 0, status: "working", label: "x", unread: 0, threadId: null },
      ]);
      const saved = editor.getState();

      editor.setState(editor.createState(docB));
      let config: EditorConfig = DEFAULT_EDITOR_CONFIG;
      for (const partial of configs) {
        editor.configure(partial);
        config = { ...config, ...partial };
      }
      editor.setState(saved);

      const { state, dom } = editor.view;
      expect(editor.getDocument()).toBe(`${docA.slice(0, at)}typed${docA.slice(at)}`);
      expect(state.selection.eq(saved.selection)).toBe(true);
      expect(getAnnotations(state), "cached badges are cleared (the host re-sends them)").toEqual(
        [],
      );
      expect(state.readOnly).toBe(config.readOnly);
      expect(dom.classList.contains("cm-ddl-live-preview")).toBe(config.livePreview);
      expect(dom.classList.contains("cm-ddl-readable")).toBe(config.readableLineLength);
      expect(dom.querySelector(".cm-gutters") !== null).toBe(config.showLineNumbers);
      editor.configure({ readOnly: false });
      undo(editor.view);
      expect(editor.getDocument()).toBe(docA);
    },
  );

  test.prop([markdownDoc(8), fc.nat(), fc.nat()])(
    "adopts plain EditorStates, keeping only document and selection",
    (doc, a, b) => {
      const anchor = a % (doc.length + 1);
      const head = b % (doc.length + 1);
      const plain = EditorState.create({
        doc,
        selection: EditorSelection.single(anchor, head),
        extensions: EditorState.allowMultipleSelections.of(true),
      });
      editor.setState(plain);
      expect(editor.getDocument()).toBe(doc);
      expect(editor.view.state.selection.main.anchor).toBe(anchor);
      expect(editor.view.state.selection.main.head).toBe(head);
      // The adopted state has the editor's extensions (history, badges).
      editor.view.dispatch({ changes: { from: 0, insert: "x" }, userEvent: "input.type" });
      expect(undoDepth(editor.view.state)).toBe(1);
    },
  );
});
