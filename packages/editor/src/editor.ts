/**
 * Baseline implementation (plain CodeMirror markdown). Live preview, annotations, vim, etc. are
 * layered in as extensions; the public contract lives in ./types.ts.
 */
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import {
  type CreateEditorOptions,
  DEFAULT_EDITOR_CONFIG,
  type EditorConfig,
  type LineAnnotation,
  type MarkdownEditor,
} from "./types";

export function createMarkdownEditor(
  parent: HTMLElement,
  options: CreateEditorOptions,
): MarkdownEditor {
  let config: EditorConfig = { ...DEFAULT_EDITOR_CONFIG, ...options.config };
  const callbacks = options.callbacks ?? {};
  const configCompartment = new Compartment();

  const configExtensions = (c: EditorConfig): Extension => [
    EditorState.readOnly.of(c.readOnly),
    EditorView.contentAttributes.of({ spellcheck: String(c.spellcheck) }),
  ];

  const extensions = (): Extension => [
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    markdown({ base: markdownLanguage }),
    EditorView.lineWrapping,
    configCompartment.of(configExtensions(config)),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        const userEvent = update.transactions.some(
          (tr) => tr.isUserEvent("input") || tr.isUserEvent("delete"),
        );
        callbacks.onDocChange?.(update.state.doc.toString(), { userEvent });
      }
    }),
  ];

  const createState = (doc: string) => EditorState.create({ doc, extensions: extensions() });
  const view = new EditorView({ state: createState(options.doc), parent });

  return {
    view,
    getDocument: () => view.state.doc.toString(),
    setDocument(doc) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc } });
    },
    createState,
    getState: () => view.state,
    setState: (state) => view.setState(state),
    setAnnotations(_annotations: readonly LineAnnotation[]) {},
    configure(partial) {
      config = { ...config, ...partial };
      view.dispatch({ effects: configCompartment.reconfigure(configExtensions(config)) });
    },
    focus: () => view.focus(),
    scrollToLine(line) {
      const pos = view.state.doc.line(Math.min(line + 1, view.state.doc.lines)).from;
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    },
    destroy: () => view.destroy(),
  };
}
