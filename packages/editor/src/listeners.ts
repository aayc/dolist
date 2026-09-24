import type { EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorCallbacks } from "./callbacks";

/** `input.*` covers typing, paste, drop, formatting and `input.toggle` (checkboxes). */
const USER_EVENTS = ["input", "delete", "move", "undo", "redo"];

function isUserChange(tr: Transaction): boolean {
  return tr.docChanged && USER_EVENTS.some((event) => tr.isUserEvent(event));
}

/** 0-based line of the main selection head. */
export function cursorLine(state: EditorState): number {
  return state.doc.lineAt(state.selection.main.head).number - 1;
}

/** Forwards document and cursor-line changes to the host callbacks, once per view update. */
export const callbackNotifier = EditorView.updateListener.of((update) => {
  const callbacks = update.state.facet(editorCallbacks);
  if (update.docChanged && callbacks.onDocChange) {
    callbacks.onDocChange(update.state.doc.toString(), {
      userEvent: update.transactions.some(isUserChange),
    });
  }
  if (callbacks.onCursorLine && (update.selectionSet || update.docChanged)) {
    const line = cursorLine(update.state);
    if (line !== cursorLine(update.startState)) callbacks.onCursorLine(line);
  }
});
