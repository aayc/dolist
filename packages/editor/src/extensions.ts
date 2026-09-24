import { closeBrackets } from "@codemirror/autocomplete";
import { history } from "@codemirror/commands";
import { indentUnit, syntaxHighlighting } from "@codemirror/language";
import { search } from "@codemirror/search";
import { type EditorSelection, EditorState, type Extension } from "@codemirror/state";
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightSpecialChars,
} from "@codemirror/view";
import { annotationField } from "./annotations/field";
import { callbacksExtension, configCompartments, resolveConfig, vimCompartment } from "./config";
import { editorKeymap } from "./keymap";
import { linkClickHandler } from "./links";
import { callbackNotifier } from "./listeners";
import { markdownLanguageData, markdownSupport } from "./syntax/language";
import { editorTheme, markdownHighlightStyle } from "./theme";
import type { EditorCallbacks, EditorConfig } from "./types";

/**
 * Configuration-independent extensions, created once and shared by every state. Indentation uses
 * tabs (4 columns wide), Obsidian's default ("Indent using tabs"), which `@ddl/core` also expects.
 */
const baseExtensions: Extension = [
  markdownSupport,
  markdownLanguageData,
  syntaxHighlighting(markdownHighlightStyle),
  history(),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  highlightSpecialChars(),
  highlightActiveLine(),
  closeBrackets(),
  search({ top: true }),
  indentUnit.of("\t"),
  EditorState.tabSize.of(4),
  EditorView.lineWrapping,
  EditorView.editorAttributes.of({ class: "cm-ddl-editor" }),
  editorTheme,
  editorKeymap,
  annotationField,
  linkClickHandler,
  callbackNotifier,
];

/** Every extension of an editor state for the given config and host callbacks. */
export function editorExtensions(config: EditorConfig, callbacks: EditorCallbacks): Extension[] {
  return [
    vimCompartment(config),
    callbacksExtension(callbacks),
    baseExtensions,
    configCompartments(config),
  ];
}

export interface HeadlessStateOptions {
  config?: Partial<EditorConfig>;
  callbacks?: EditorCallbacks;
  selection?: EditorSelection | { anchor: number; head?: number };
}

/**
 * A state with the full editor extension set and no view: for tests, benchmarks and precomputing
 * states off-screen. (View plugins such as the live preview only run once a view mounts it.)
 */
export function createHeadlessEditorState(
  doc: string,
  options: HeadlessStateOptions = {},
): EditorState {
  return EditorState.create({
    doc,
    ...(options.selection === undefined ? {} : { selection: options.selection }),
    extensions: editorExtensions(resolveConfig(options.config), options.callbacks ?? {}),
  });
}
