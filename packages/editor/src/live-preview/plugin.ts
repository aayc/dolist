import { syntaxTree } from "@codemirror/language";
import { type Extension, Facet } from "@codemirror/state";
import { type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { embedController, embedSelection } from "../embeds/layer";
import { buildLivePreviewDecorations } from "./decorations";

/** Whether the live preview is on, for decorations that render differently in source mode. */
export const livePreviewEnabled = Facet.define<boolean, boolean>({
  combine: (values) => values.some(Boolean),
});

/** Focus anywhere in the editor (content, vim/search panels, a badge) keeps syntax revealed. */
export function hasFocusWithin(view: EditorView): boolean {
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
        syntaxTree(update.startState) !== syntaxTree(update.state) ||
        update.startState.field(embedSelection, false) !== update.state.field(embedSelection, false)
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
  embedSelection,
  embedController,
  livePreviewEnabled.of(true),
  EditorView.editorAttributes.of({ class: "cm-ddl-live-preview" }),
];
