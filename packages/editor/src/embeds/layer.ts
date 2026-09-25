/**
 * The embed layer's state: which embed is selected, the renderers the host registered, and the
 * embeds currently drawn (so a host can start editing one it just inserted).
 */
import {
  type EditorState,
  MapMode,
  StateEffect,
  StateField,
  type Transaction,
} from "@codemirror/state";
import { type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { editorCallbacks } from "../callbacks";
import { insertEmbed } from "./edits";
import { embedAt } from "./parse";
import type { BlockEmbed, EmbedContent, EmbedRenderer } from "./types";

const NO_RENDERERS: readonly EmbedRenderer[] = [];

export function embedRenderers(state: EditorState): readonly EmbedRenderer[] {
  return state.facet(editorCallbacks).embedRenderers ?? NO_RENDERERS;
}

export function rendererFor(state: EditorState, target: string): EmbedRenderer | null {
  for (const renderer of embedRenderers(state)) if (renderer.matches(target)) return renderer;
  return null;
}

/** Selects the embed whose `![[` is at the position (null deselects). */
export const selectEmbedEffect = StateEffect.define<number | null>({
  map: (value, mapping) => (value === null ? null : mapping.mapPos(value, 1, MapMode.TrackDel)),
});

function mapSelection(value: number, tr: Transaction): number | null {
  const mapped = tr.changes.mapPos(value, 1, MapMode.TrackDel);
  if (mapped === null) return null;
  return embedAt(tr.state.doc, mapped) ? mapped : null;
}

/**
 * The selected embed's position. Selecting an embed doesn't move the caret (which would reveal its
 * syntax); moving the caret, or an edit that removes the embed, deselects it.
 */
export const embedSelection = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(selectEmbedEffect)) return effect.value;
    if (value === null) return null;
    const next = tr.docChanged ? mapSelection(value, tr) : value;
    if (tr.selection && !tr.selection.eq(tr.startState.selection)) return null;
    return next;
  },
});

/** The selected embed, if any. */
export function selectedEmbed(state: EditorState): BlockEmbed | null {
  const from = state.field(embedSelection, false);
  return from === null || from === undefined ? null : embedAt(state.doc, from);
}

/** An embed drawn in the editor. */
export interface MountedEmbed {
  readonly frame: HTMLElement;
  readonly content: EmbedContent;
  /** Where its `![[` is now, or null when it's gone. */
  position(): number | null;
  focus(): void;
}

class EmbedController {
  readonly mounted = new Set<MountedEmbed>();
  private readonly view: EditorView;

  constructor(view: EditorView) {
    this.view = view;
  }

  update(update: ViewUpdate): void {
    const selected = update.state.field(embedSelection, false) ?? null;
    if (selected === null) return;
    if (
      selected !== (update.startState.field(embedSelection, false) ?? null) ||
      update.docChanged
    ) {
      this.view.requestMeasure({ key: this, read: () => null, write: () => this.focusSelected() });
    }
  }

  find(from: number): MountedEmbed | null {
    for (const mounted of this.mounted) if (mounted.position() === from) return mounted;
    return null;
  }

  private focusSelected(): void {
    const selected = this.view.state.field(embedSelection, false) ?? null;
    if (selected === null) return;
    const mounted = this.find(selected);
    if (mounted && !mounted.frame.contains(this.view.root.activeElement)) mounted.focus();
  }
}

export const embedController = ViewPlugin.fromClass(EmbedController);

/** Selects the embed at `from` (its `![[`), or deselects with null. */
export function selectEmbed(view: EditorView, from: number | null): void {
  view.dispatch({ effects: selectEmbedEffect.of(from) });
}

/** Double-click on the embed at `from`, if it's drawn. False when it isn't or has nothing to do. */
export function activateEmbed(view: EditorView, from: number): boolean {
  const mounted = view.plugin(embedController)?.find(from);
  return mounted?.content.activate?.() ?? false;
}

/** Inserts `text` (an `![[…]]`) on its own line at the caret's line; returns where it starts. */
export function insertEmbedAtCursor(view: EditorView, text: string): number {
  const edit = insertEmbed(view.state, text);
  view.dispatch(edit.spec);
  return edit.from;
}
