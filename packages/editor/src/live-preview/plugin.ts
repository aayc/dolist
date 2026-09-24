import { syntaxTree } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { buildLivePreviewDecorations } from "./decorations";

/** Focus anywhere in the editor (content, vim/search panels, a badge) keeps syntax revealed. */
function hasFocusWithin(view: EditorView): boolean {
  if (view.hasFocus) return true;
  const active = view.root.activeElement;
  return active !== null && view.dom.contains(active);
}

function build(view: EditorView): DecorationSet {
  return buildLivePreviewDecorations(view.state, view.visibleRanges, hasFocusWithin(view));
}

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = build(view);
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        update.focusChanged ||
        update.transactions.some((tr) => tr.reconfigured) ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = build(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/** Obsidian-style live preview (toggled through the `livePreview` config compartment). */
export const livePreview: Extension = [
  livePreviewPlugin,
  EditorView.editorAttributes.of({ class: "cm-ddl-live-preview" }),
];
