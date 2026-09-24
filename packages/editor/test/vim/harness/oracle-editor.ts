/**
 * The oracle: plain CodeMirror 6 with `vim()` and the README's defaults, in a fixed 20-row
 * viewport with 20px lines, the generated oracle font and no wrapping.
 */
import {
  cursorCharLeft,
  cursorCharRight,
  cursorLineDown,
  cursorLineUp,
  history,
} from "@codemirror/commands";
import { indentUnit } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { drawSelection, EditorView, keymap } from "@codemirror/view";
import { vim } from "@replit/codemirror-vim";
import { VIEWPORT } from "../format";
import {
  deleteByGrapheme,
  type EditorSpec,
  type HarnessEditor,
  ORACLE_FONT_STACK,
} from "./harness";

/**
 * The native edits of README rule 2 as key bindings. vim.js replays a recorded insert-mode
 * Backspace/Delete through the editor's keymap (`CodeMirror.keys.Backspace` runs the "editor"
 * scope handlers), and real keyboard events (the upstream suite) reach Enter/Tab the same way.
 * Arrow keys in insert-mode mappings (`imap <C-l> <Right>`) also run through the keymap, so the
 * oracle binds them like CodeMirror's default keymap does.
 */
const nativeEditKeymap = keymap.of([
  { key: "ArrowLeft", run: cursorCharLeft },
  { key: "ArrowRight", run: cursorCharRight },
  { key: "ArrowUp", run: cursorLineUp },
  { key: "ArrowDown", run: cursorLineDown },
  {
    key: "Backspace",
    run: (view) => {
      view.dispatch(
        view.state.update(deleteByGrapheme(view.state, false), { userEvent: "delete.backward" }),
      );
      return true;
    },
  },
  {
    key: "Delete",
    run: (view) => {
      view.dispatch(
        view.state.update(deleteByGrapheme(view.state, true), { userEvent: "delete.forward" }),
      );
      return true;
    },
  },
  {
    key: "Enter",
    run: (view) => {
      view.dispatch(view.state.replaceSelection("\n"), { userEvent: "input.type" });
      return true;
    },
  },
  {
    key: "Tab",
    run: (view) => {
      view.dispatch(view.state.replaceSelection("\t"), { userEvent: "input.type" });
      return true;
    },
  },
]);

export const viewportTheme = EditorView.theme({
  "&": { height: `${VIEWPORT.rows * VIEWPORT.lineHeight}px`, width: "900px" },
  ".cm-scroller": {
    fontFamily: ORACLE_FONT_STACK,
    fontSize: "16px",
    lineHeight: `${VIEWPORT.lineHeight}px`,
    overflow: "auto",
    scrollbarWidth: "none",
  },
  ".cm-content": { padding: "0" },
  ".cm-line": { padding: "0", lineHeight: `${VIEWPORT.lineHeight}px` },
});

export function oracleExtensions(spec: Pick<EditorSpec, "tabSize" | "indentUnit">) {
  return [
    vim(),
    history(),
    drawSelection(),
    EditorState.allowMultipleSelections.of(true),
    EditorState.tabSize.of(spec.tabSize),
    indentUnit.of(spec.indentUnit),
    nativeEditKeymap,
    viewportTheme,
  ];
}

export function createOracleEditor(parent: HTMLElement, spec: EditorSpec): HarnessEditor {
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc: spec.doc, extensions: oracleExtensions(spec) }),
  });
  return { view, destroy: () => view.destroy() };
}
