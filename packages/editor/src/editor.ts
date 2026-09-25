/**
 * `createMarkdownEditor`: the host-facing wrapper around one EditorView. The public contract lives
 * in ./types.ts; everything here is glue between that contract and the extensions.
 */
import {
  type ChangeSet,
  EditorSelection,
  EditorState,
  type SelectionRange,
  type Text,
  Transaction,
  type TransactionSpec,
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { resetActivityChipsEffect, setActivityChipsEffect } from "./activity/field";
import { resetAnnotationsEffect, setAnnotationsEffect } from "./annotations/field";
import {
  callbacksEffect,
  configEffects,
  hasEditorCompartments,
  resolveConfig,
  vimEffect,
} from "./config";
import { documentChanges, normalizeLineEndings, type TextChange } from "./diff";
import { editorExtensions } from "./extensions";
import { cursorLine } from "./listeners";
import type { CreateEditorOptions, EditorConfig, MarkdownEditor } from "./types";
import { isVimLoaded, onVimLoaded } from "./vim";

/**
 * Whole lines inserted at the start of a line belong above it, so a caret at that line start
 * moves down with its line instead of landing on the inserted text. (Selection ranges already
 * map that way: their start moves with the text after it, their end stays before it.)
 */
function selectionAfterLinesInserted(
  state: EditorState,
  changes: readonly TextChange[],
  changeSet: ChangeSet,
): EditorSelection | undefined {
  const lineStarts = new Set<number>();
  for (const { from, to, insert } of changes) {
    if (from === to && insert.endsWith("\n") && isLineStart(state.doc, from)) lineStarts.add(from);
  }
  const { selection } = state;
  const moves = (r: SelectionRange) => r.empty && lineStarts.has(r.head);
  if (!selection.ranges.some(moves)) return undefined;
  return EditorSelection.create(
    selection.ranges.map((r) =>
      moves(r) ? EditorSelection.cursor(changeSet.mapPos(r.head, 1)) : r.map(changeSet),
    ),
    selection.mainIndex,
  );
}

function isLineStart(doc: Text, pos: number): boolean {
  return pos === 0 || doc.sliceString(pos - 1, pos) === "\n";
}

/**
 * `doc` replacing the state's document as an external edit: only the lines that differ change,
 * so the selection, badges and the undo history of edits elsewhere survive. External edits are
 * not undoable themselves. Null when nothing differs.
 */
export function externalChange(state: EditorState, doc: string): TransactionSpec | null {
  const list = documentChanges(state.doc.toString(), normalizeLineEndings(doc));
  if (list.length === 0) return null;
  const changes = state.changes(list);
  const selection = selectionAfterLinesInserted(state, list, changes);
  return {
    changes,
    ...(selection ? { selection } : {}),
    annotations: [Transaction.addToHistory.of(false), Transaction.remote.of(true)],
  };
}

/** `state` with `doc` applied as an external edit (see `externalChange`), e.g. a cached state. */
export function withDocument(state: EditorState, doc: string): EditorState {
  const spec = externalChange(state, doc);
  return spec ? state.update(spec).state : state;
}

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
          resetAnnotationsEffect.of(null),
          resetActivityChipsEffect.of(null),
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
      if (resetHistory) {
        swapState(createState(normalizeLineEndings(doc)), false);
        return;
      }
      const spec = externalChange(view.state, doc);
      if (spec) view.dispatch(spec);
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

    setActivityChips(chips) {
      view.dispatch({ effects: setActivityChipsEffect.of(chips) });
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
