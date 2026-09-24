/**
 * The Daily Do List editor (`createMarkdownEditor`, vim on, live preview on) as a harness editor.
 * Only geometry is pinned to the oracle's (see WEB_GEOMETRY_CSS); every extension is the real one.
 */
import { indentUnit } from "@codemirror/language";
import { EditorState, Prec, StateEffect } from "@codemirror/state";
import { createMarkdownEditor } from "../../../src/editor";
import type { MarkdownEditor } from "../../../src/types";
import { VIEWPORT } from "../format";
import { type EditorSpec, type HarnessEditor, ORACLE_FONT_STACK } from "./harness";

/**
 * vim's viewport and display-line commands measure pixels, so the replay gives the editor the
 * oracle's fixed geometry: a 20-row viewport of 20px monospace lines without padding or wrapping
 * pressure. Styles, decorations and widgets otherwise stay as the app ships them.
 */
export const WEB_GEOMETRY_CSS = `
.vim-geometry .cm-editor { height: ${VIEWPORT.rows * VIEWPORT.lineHeight}px !important; width: 900px !important; }
.vim-geometry .cm-scroller, .vim-font .cm-scroller { overflow: auto !important; scrollbar-width: none !important; }
.vim-geometry :is(.cm-scroller, .cm-content, .cm-line), .vim-font :is(.cm-scroller, .cm-content, .cm-line) {
  font-family: ${ORACLE_FONT_STACK} !important; font-size: 16px !important; line-height: ${VIEWPORT.lineHeight}px !important;
}
.vim-geometry .cm-content, .vim-font .cm-content { padding: 0 !important; }
.vim-geometry .cm-line, .vim-font .cm-line { padding: 0 !important; }
`;

export function webEditor(parent: HTMLElement, spec: EditorSpec): MarkdownEditor {
  const editor = createMarkdownEditor(parent, {
    doc: spec.doc,
    config: { vimMode: true, livePreview: true, readableLineLength: false },
  });
  editor.view.dispatch({
    effects: StateEffect.appendConfig.of(
      Prec.highest([EditorState.tabSize.of(spec.tabSize), indentUnit.of(spec.indentUnit)]),
    ),
  });
  return editor;
}

export function createWebHarnessEditor(parent: HTMLElement, spec: EditorSpec): HarnessEditor {
  const editor = webEditor(parent, spec);
  return { view: editor.view, destroy: () => editor.destroy() };
}
