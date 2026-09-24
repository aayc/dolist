/**
 * `createMarkdownEditor`: the host-facing wrapper around one EditorView. The public contract lives
 * in ./types.ts; everything here is glue between that contract and the extensions.
 */
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { setAnnotationsEffect } from "./annotations/field";
import {
  callbacksEffect,
  configEffects,
  hasEditorCompartments,
  resolveConfig,
  vimEffect,
} from "./config";
import { minimalChange, normalizeLineEndings } from "./diff";
import { editorExtensions } from "./extensions";
import { cursorLine } from "./listeners";
import type { CreateEditorOptions, EditorConfig, MarkdownEditor } from "./types";
import { isVimLoaded, onVimLoaded } from "./vim";

export function createMarkdownEditor(
  parent: HTMLElement,
  options: CreateEditorOptions,
): MarkdownEditor {
  let config: EditorConfig = resolveConfig(options.config);
  const callbacks = options.callbacks ?? {};

  const createState = (doc: string): EditorState =>
    EditorState.create({
      doc: normalizeLineEndings(doc),
      extensions: editorExtensions(config, callbacks),
    });

  const view = new EditorView({ state: createState(options.doc), parent });
  let destroyed = false;
  let stopWaitingForVim: (() => void) | null = null;

  const ensureVim = (): void => {
    if (!config.vimMode || isVimLoaded() || stopWaitingForVim) return;
    stopWaitingForVim = onVimLoaded(() => {
      stopWaitingForVim = null;
      if (!destroyed && config.vimMode) view.dispatch({ effects: vimEffect(config) });
    });
  };
  ensureVim();

  const swapState = (state: EditorState, reapply: boolean): void => {
    const previousLine = cursorLine(view.state);
    view.setState(state);
    if (reapply) {
      view.dispatch({
        effects: [
          ...configEffects(null, config),
          callbacksEffect(callbacks),
          setAnnotationsEffect.of([]),
        ],
      });
    }
    const line = cursorLine(view.state);
    if (line !== previousLine) callbacks.onCursorLine?.(line);
  };

  return {
    view,

    getDocument: () => view.state.doc.toString(),

    setDocument(doc, { resetHistory = false } = {}) {
      const next = normalizeLineEndings(doc);
      if (resetHistory) {
        swapState(createState(next), false);
        return;
      }
      const change = minimalChange(view.state.doc.toString(), next);
      if (!change) return;
      // External edits are not undoable; local history is mapped through them instead.
      view.dispatch({
        changes: change,
        annotations: [Transaction.addToHistory.of(false), Transaction.remote.of(true)],
      });
    },

    createState,

    getState: () => view.state,

    setState(state) {
      // A state from elsewhere (no editor compartments) keeps its document and selection only.
      if (!hasEditorCompartments(state)) {
        const adopted = EditorState.create({
          doc: state.doc,
          selection: state.selection,
          extensions: editorExtensions(config, callbacks),
        });
        swapState(adopted, false);
        return;
      }
      swapState(state, true);
    },

    setAnnotations(annotations) {
      view.dispatch({ effects: setAnnotationsEffect.of(annotations) });
    },

    configure(partial) {
      const next = resolveConfig(partial, config);
      const effects = configEffects(config, next);
      config = next;
      if (effects.length > 0) view.dispatch({ effects });
      ensureVim();
    },

    focus: () => view.focus(),

    scrollToLine(line) {
      if (!Number.isFinite(line)) return;
      const { doc } = view.state;
      const n = Math.min(Math.max(Math.floor(line), 0), doc.lines - 1);
      const pos = doc.line(n + 1).from;
      view.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: "center" }),
      });
    },

    destroy: () => {
      destroyed = true;
      stopWaitingForVim?.();
      view.destroy();
    },
  };
}
