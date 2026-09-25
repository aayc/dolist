/**
 * The embed layer's contract with hosts. An embed is an `![[target|…]]` alone on its line, with
 * Obsidian's size and placement modifiers (`360`, `360x240`, `50%`, `left`, `right`, `center`,
 * `left-wrap`, `right-wrap`; none is full width). The layer owns the box around it (placement,
 * size, selection, moving, resizing, deleting); a renderer the host registers owns what's inside.
 */
import type { EditorView } from "@codemirror/view";
import type { DrawingEmbedSpec, DrawingPlacement } from "@ddl/core";

/** Where an embed sits: a float with text wrapping around it, or a row of its own. */
export type EmbedPlacement = DrawingPlacement;

/** The parsed modifiers of an embed (the Obsidian Excalidraw plugin's grammar, shared by images). */
export type EmbedSpec = DrawingEmbedSpec;

/** An embed alone on its line (leading and trailing whitespace allowed). */
export interface BlockEmbed {
  /** Offsets of `![[…]]`. */
  from: number;
  to: number;
  /** The line holding it. */
  lineFrom: number;
  lineTo: number;
  /** `![[…]]` as written. */
  text: string;
  spec: EmbedSpec;
}

/** Draws one kind of embed (drawings; images next). Registered through `EditorCallbacks.embedRenderers`. */
export interface EmbedRenderer {
  /** A short stable name; the box gets the class `cm-ddl-embed-<kind>`. */
  readonly kind: string;
  /** Whether this renderer draws `target` as written (`Plan.excalidraw`, `photo.png`). */
  matches(target: string): boolean;
  /** Renders the embed into `host.dom`. Called when its line is drawn (it scrolls into view). */
  mount(host: EmbedHost): EmbedContent;
}

export interface EmbedHost {
  /** Where the content goes. The layer sizes it: width from the modifiers, height from the content. */
  readonly dom: HTMLElement;
  readonly view: EditorView;
  /** The spec it was mounted with; `EmbedContent.update` reports changes. */
  readonly spec: EmbedSpec;
  /** The embed's current position, or null once it left the document. */
  embed(): BlockEmbed | null;
  /**
   * The content's size in CSS pixels at 100%: its aspect ratio reserves the box's height before
   * the content arrives, and its width is the box's width when the embed names none.
   */
  setNaturalSize(size: { width: number; height: number } | null): void;
}

export interface EmbedContent {
  /** New modifiers for the same target. Return false to be remounted instead. */
  update?(spec: EmbedSpec): boolean;
  /** Double-click, or Enter while selected. Return false when there's nothing to do. */
  activate?(): boolean;
  destroy(): void;
}
