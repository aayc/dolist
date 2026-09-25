import { drawingTitleFromPath } from "@ddl/core";
import type { EmbedContent, EmbedHost } from "@ddl/editor";
import type { DrawingDoc, Drawings } from "./drawing-store";
import type { DrawingRenders, RenderedDrawing } from "./render-cache";

/** What an embedded drawing needs from the app. */
export interface DrawingEmbedContext {
  drawings: Drawings;
  renders: DrawingRenders;
  /** The vault path an embed's target names, or null. */
  resolve(target: string): string | null;
  /** Calls back when the vault's files change (a target may resolve now). */
  onFilesChanged(listener: () => void): () => void;
  /** Double-click or Enter: edit it in place. */
  edit(view: DrawingEmbedView): void;
  /** The embed went away (scrolled out, note switched, line removed). */
  gone(view: DrawingEmbedView): void;
}

/**
 * A drawing in a note: its static render, re-rendered only when the file changes (renders are
 * cached by content hash, so scrolling back or a second embed costs a clone).
 */
export class DrawingEmbedView implements EmbedContent {
  readonly host: EmbedHost;
  private readonly context: DrawingEmbedContext;
  private pathValue: string | null = null;
  private doc: DrawingDoc | null = null;
  private painted: string | null = null;
  private settledWaiters: Array<() => void> = [];
  private unsubscribe: (() => void) | null = null;
  private stopWaitingForFile: (() => void) | null = null;
  private destroyed = false;

  constructor(host: EmbedHost, context: DrawingEmbedContext) {
    this.host = host;
    this.context = context;
    host.dom.classList.add("drawing-embed");
    host.dom.setAttribute("role", "img");
    this.connect();
  }

  get path(): string | null {
    return this.pathValue;
  }

  /** Resolves once the latest version of the file is on screen. */
  settled(): Promise<void> {
    const current = this.pathValue ? this.context.drawings.get(this.pathValue) : null;
    if (!current || this.painted === current.hash) return Promise.resolve();
    return new Promise((resolve) => this.settledWaiters.push(resolve));
  }

  setEditing(editing: boolean): void {
    this.host.dom.classList.toggle("is-editing", editing);
  }

  update(): boolean {
    return true;
  }

  activate(): boolean {
    if (!this.pathValue || !this.doc?.parsed.readable) return false;
    this.context.edit(this);
    return true;
  }

  destroy(): void {
    this.destroyed = true;
    this.unsubscribe?.();
    this.stopWaitingForFile?.();
    this.context.gone(this);
    for (const resolve of this.settledWaiters.splice(0)) resolve();
  }

  private connect(): void {
    const { target } = this.host.spec;
    const path = this.context.resolve(target);
    const name = drawingTitleFromPath(path ?? target);
    this.host.dom.setAttribute("aria-label", `Drawing “${name}”`);
    if (!path) {
      this.message(`“${name}” doesn't exist`);
      this.stopWaitingForFile ??= this.context.onFilesChanged(() => {
        if (this.destroyed || !this.context.resolve(target)) return;
        this.stopWaitingForFile?.();
        this.stopWaitingForFile = null;
        this.connect();
      });
      return;
    }
    this.pathValue = path;
    this.host.dom.dataset.path = path;
    this.unsubscribe = this.context.drawings.subscribe(path, (doc) => {
      if (doc) this.show(doc);
      else this.message(`“${name}” was deleted`);
    });
    const loaded = this.context.drawings.get(path);
    if (loaded) this.show(loaded);
    else {
      this.context.drawings.load(path).then(
        (doc) => this.show(doc),
        () => this.message(`Couldn't open “${name}”`),
      );
    }
  }

  private show(doc: DrawingDoc): void {
    if (this.destroyed) return;
    this.doc = doc;
    if (!doc.parsed.readable) {
      this.message("This drawing can't be read");
      return;
    }
    const ready = this.context.renders.peek(doc.hash);
    if (ready) {
      this.paint(doc, ready);
      return;
    }
    this.host.dom.classList.add("is-rendering");
    this.context.renders.get(doc.hash, doc.parsed.scene).then(
      (rendered) => {
        if (this.doc === doc) this.paint(doc, rendered);
      },
      () => {
        if (this.doc === doc) this.message("Couldn't draw this drawing");
      },
    );
  }

  private paint(doc: DrawingDoc, rendered: RenderedDrawing): void {
    if (this.destroyed) return;
    const dom = this.host.dom;
    dom.classList.remove("is-rendering", "is-message");
    this.host.setNaturalSize(
      rendered.svg ? { width: rendered.width, height: rendered.height } : null,
    );
    if (rendered.svg) {
      dom.replaceChildren(rendered.svg.cloneNode(true));
      dom.classList.remove("is-empty");
    } else {
      const hint = dom.ownerDocument.createElement("span");
      hint.className = "drawing-embed-hint";
      hint.textContent = "Empty drawing · double-click to draw";
      dom.replaceChildren(hint);
      dom.classList.add("is-empty");
    }
    this.painted = doc.hash;
    for (const resolve of this.settledWaiters.splice(0)) resolve();
  }

  private message(text: string): void {
    if (this.destroyed) return;
    const dom = this.host.dom;
    const span = dom.ownerDocument.createElement("span");
    span.className = "drawing-embed-hint";
    span.textContent = text;
    dom.replaceChildren(span);
    dom.classList.remove("is-rendering", "is-empty");
    dom.classList.add("is-message");
    this.host.setNaturalSize(null);
    for (const resolve of this.settledWaiters.splice(0)) resolve();
  }
}
