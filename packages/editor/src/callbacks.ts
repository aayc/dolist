import { Facet, type StateCommand } from "@codemirror/state";
import type { EditorCallbacks } from "./types";

const NO_CALLBACKS: EditorCallbacks = {};

/**
 * Host callbacks, read at event time from the state. Each editor provides its own value through a
 * compartment it re-applies on `setState`, so a cached state always talks to the editor showing it.
 */
export const editorCallbacks = Facet.define<EditorCallbacks, EditorCallbacks>({
  combine: (values) => values[0] ?? NO_CALLBACKS,
});

/** Mod-s (and vim `:w`). Always handled so the browser's "save page" never opens. */
export const saveDocument: StateCommand = ({ state }) => {
  state.facet(editorCallbacks).onSave?.();
  return true;
};
