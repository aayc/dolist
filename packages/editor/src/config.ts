/**
 * Runtime-configurable parts of the editor, one compartment per `EditorConfig` key. Compartments
 * are module-level so any state built by this package can be reconfigured by any editor instance.
 */
import { foldGutter } from "@codemirror/language";
import { Compartment, EditorState, type Extension, type StateEffect } from "@codemirror/state";
import { EditorView, highlightActiveLineGutter, lineNumbers } from "@codemirror/view";
import { editorCallbacks } from "./callbacks";
import { livePreview } from "./live-preview/plugin";
import { DEFAULT_EDITOR_CONFIG, type EditorCallbacks, type EditorConfig } from "./types";
import { vimMode } from "./vim";

type ConfigKey = keyof EditorConfig;

const compartments: Record<ConfigKey, Compartment> = {
  vimMode: new Compartment(),
  livePreview: new Compartment(),
  readableLineLength: new Compartment(),
  spellcheck: new Compartment(),
  showLineNumbers: new Compartment(),
  fontSize: new Compartment(),
  readOnly: new Compartment(),
};

const callbacksCompartment = new Compartment();

const readableLineLength = EditorView.editorAttributes.of({ class: "cm-ddl-readable" });
const gutters: Extension = [lineNumbers(), highlightActiveLineGutter(), foldGutter()];

const builders: { [K in ConfigKey]: (config: EditorConfig) => Extension } = {
  vimMode: (c) => vimMode(c.vimMode),
  livePreview: (c) => (c.livePreview ? livePreview : []),
  readableLineLength: (c) => (c.readableLineLength ? readableLineLength : []),
  spellcheck: (c) =>
    EditorView.contentAttributes.of({ spellcheck: c.spellcheck ? "true" : "false" }),
  showLineNumbers: (c) => (c.showLineNumbers ? gutters : []),
  fontSize: (c) =>
    EditorView.editorAttributes.of({ style: `--ddl-editor-font-size: ${c.fontSize}px` }),
  readOnly: (c) => [EditorState.readOnly.of(c.readOnly), EditorView.editable.of(!c.readOnly)],
};

const CONFIG_KEYS = Object.keys(compartments) as ConfigKey[];
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 72;

/** Merges a partial config over `base`, sanitizing values that end up in CSS. */
export function resolveConfig(
  partial: Partial<EditorConfig> = {},
  base: EditorConfig = DEFAULT_EDITOR_CONFIG,
): EditorConfig {
  const merged = { ...base, ...partial };
  const fontSize = Number.isFinite(merged.fontSize)
    ? Math.min(Math.max(merged.fontSize, MIN_FONT_SIZE), MAX_FONT_SIZE)
    : base.fontSize;
  return {
    vimMode: Boolean(merged.vimMode),
    livePreview: Boolean(merged.livePreview),
    readableLineLength: Boolean(merged.readableLineLength),
    spellcheck: Boolean(merged.spellcheck),
    showLineNumbers: Boolean(merged.showLineNumbers),
    fontSize,
    readOnly: Boolean(merged.readOnly),
  };
}

/** The vim compartment. Must be the very first extension of the state. */
export function vimCompartment(config: EditorConfig): Extension {
  return compartments.vimMode.of(builders.vimMode(config));
}

/** Re-applies the vim compartment (used once the lazily-loaded vim module arrives). */
export function vimEffect(config: EditorConfig): StateEffect<unknown> {
  return compartments.vimMode.reconfigure(builders.vimMode(config));
}

/** Every other config compartment. */
export function configCompartments(config: EditorConfig): Extension[] {
  return CONFIG_KEYS.filter((key) => key !== "vimMode").map((key) =>
    compartments[key].of(builders[key](config)),
  );
}

export function callbacksExtension(callbacks: EditorCallbacks): Extension {
  return callbacksCompartment.of(editorCallbacks.of(callbacks));
}

/** Reconfigure effects for the keys that differ between `prev` and `next` (all when prev is null). */
export function configEffects(
  prev: EditorConfig | null,
  next: EditorConfig,
): StateEffect<unknown>[] {
  return CONFIG_KEYS.filter((key) => prev === null || prev[key] !== next[key]).map((key) =>
    compartments[key].reconfigure(builders[key](next)),
  );
}

export function callbacksEffect(callbacks: EditorCallbacks): StateEffect<unknown> {
  return callbacksCompartment.reconfigure(editorCallbacks.of(callbacks));
}

/** Whether a state was built by this package (and so carries the config compartments). */
export function hasEditorCompartments(state: EditorState): boolean {
  return compartments.readOnly.get(state) !== undefined;
}
