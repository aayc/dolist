import type { DrawingElement } from "@ddl/core";
import type { EmbedHost } from "@ddl/editor";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { DrawingView } from "./DrawingEditor";
import type { DrawingEditing } from "./drawing-editing";
import type { Drawings } from "./drawing-store";
import type { ExcalidrawLib } from "./excalidraw-loader";

/** Room above the drawing for Excalidraw's tool bar, and below it for its footer. */
const TOOLBAR_SPACE = 72;
const FOOTER_SPACE = 60;
/** Excalidraw uses its phone layout below 730 px of width, or 500 of height (under 1000 wide). */
const MIN_WIDTH = 760;
const MIN_HEIGHT = 520;
const MAX_HEIGHT = 2400;
/** Kept between the drawing and the overlay's bottom edge as the drawing grows. */
const GROW_MARGIN = 96;
const EDGE = 8;

export type OverlayCloseReason = "escape" | "outside" | "done" | "gone";

export interface DrawingOverlayOptions {
  host: EmbedHost;
  path: string;
  drawings: Drawings;
  /** Resolves once the embed shows the latest version (so closing doesn't flash an old one). */
  previewSettled(): Promise<void>;
  onClosed(reason: OverlayCloseReason): void;
  onError(error: unknown): void;
}

const CHECK_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

/** Whether Escape belongs to Excalidraw: a text being typed, a shape being drawn, a menu open. */
function excalidrawWantsEscape(api: ExcalidrawImperativeAPI | null): boolean {
  if (!api) return false;
  const state = api.getAppState();
  return Boolean(
    state.editingTextElement ||
      state.newElement ||
      state.multiElement ||
      state.editingLinearElement ||
      state.openMenu ||
      state.openPopup ||
      state.openDialog ||
      state.contextMenu,
  );
}

/**
 * Editing a drawing in place: Excalidraw over the note, its canvas lined up with the drawing's
 * box so the drawing doesn't move, the tool bar above it. It grows as the drawing does. Escape,
 * a click outside or Done ends it, after saving and once the box shows the new version.
 */
export class DrawingOverlay {
  readonly element: HTMLElement;
  private readonly options: DrawingOverlayOptions;
  private readonly canvas: HTMLElement;
  private editing: DrawingEditing | null = null;
  private closing: Promise<void> | null = null;
  private readonly abort = new AbortController();
  private growFrame = 0;
  /** Where the drawing's box is inside the overlay. */
  private boxOffset = { x: 0, y: TOOLBAR_SPACE };

  constructor(options: DrawingOverlayOptions) {
    this.options = options;
    const doc = options.host.view.dom.ownerDocument;
    this.element = doc.createElement("div");
    this.element.className = "drawing-overlay is-loading";
    this.element.dataset.testid = "drawing-editor";
    this.element.setAttribute("role", "dialog");
    this.element.setAttribute("aria-label", "Drawing editor");
    this.canvas = doc.createElement("div");
    this.canvas.className = "drawing-overlay-canvas";
    const done = doc.createElement("button");
    done.type = "button";
    done.className = "drawing-overlay-done";
    done.dataset.testid = "drawing-done";
    done.dataset.tooltip = "Done";
    done.dataset.tooltipKeys = "escape";
    done.setAttribute("aria-label", "Done");
    done.innerHTML = CHECK_ICON;
    done.addEventListener("click", () => void this.close("done"));
    this.element.append(this.canvas, done);
    options.host.view.scrollDOM.appendChild(this.element);
    this.place();
    this.listen();
    void this.open();
  }

  get isClosing(): boolean {
    return this.closing !== null;
  }

  /** Saves what's pending without closing. */
  flush(): Promise<void> {
    return this.editing?.flush() ?? Promise.resolve();
  }

  close(reason: OverlayCloseReason): Promise<void> {
    this.closing ??= this.finish(reason);
    return this.closing;
  }

  private async open(): Promise<void> {
    try {
      // Loaded with Excalidraw, the first time a drawing is edited.
      const { DrawingEditing } = await import("./drawing-editing");
      const editing = await DrawingEditing.open({
        drawings: this.options.drawings,
        path: this.options.path,
        container: this.canvas,
        view: (elements, lib) => this.initialView(elements, lib),
        onChange: (api) => this.scheduleGrow(api),
        onError: this.options.onError,
      });
      if (this.closing) {
        await editing.close();
        return;
      }
      this.editing = editing;
      this.element.classList.remove("is-loading");
    } catch (error) {
      this.options.onError(error);
      void this.close("gone");
    }
  }

  private async finish(reason: OverlayCloseReason): Promise<void> {
    this.abort.abort();
    cancelAnimationFrame(this.growFrame);
    try {
      await this.editing?.flush();
      await Promise.race([
        this.options.previewSettled(),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
    } catch (error) {
      this.options.onError(error);
    }
    try {
      await this.editing?.close();
    } catch (error) {
      this.options.onError(error);
    }
    this.element.remove();
    this.options.onClosed(reason);
  }

  // ── Placement ───────────────────────────────────────────────────────────

  /**
   * Over the drawing's box, centered on the text column and wide enough for Excalidraw's desktop
   * layout when the pane allows, with the tool bar above the box (or at the top of the note).
   */
  private place(): void {
    const { host } = this.options;
    const scroller = host.view.scrollDOM;
    const content = host.view.contentDOM;
    const box = host.dom.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    const style = getComputedStyle(content);
    const columnLeft = contentRect.left + Number.parseFloat(style.paddingLeft || "0");
    const columnRight = contentRect.right - Number.parseFloat(style.paddingRight || "0");
    const available = scroller.clientWidth - 2 * EDGE;
    const width = Math.min(
      Math.max(columnRight - columnLeft, box.width + 2 * EDGE, MIN_WIDTH),
      available,
    );
    const minLeft = scrollerRect.left + EDGE;
    const maxLeft = minLeft + available - width;
    const centered = (columnLeft + columnRight - width) / 2;
    // Centered on the column, but never leaving the box out.
    const left = Math.min(
      Math.max(Math.min(centered, box.left - EDGE), box.right + EDGE - width, minLeft),
      maxLeft,
    );
    const toScroller = scroller.scrollTop - scrollerRect.top;
    const top = Math.max(box.top + toScroller - TOOLBAR_SPACE, 0);
    const height = Math.max(box.height + TOOLBAR_SPACE + FOOTER_SPACE, MIN_HEIGHT);
    this.boxOffset = { x: box.left - left, y: TOOLBAR_SPACE };
    Object.assign(this.element.style, {
      left: `${left - scrollerRect.left + scroller.scrollLeft}px`,
      top: `${top}px`,
      width: `${width}px`,
      height: `${height}px`,
    });
    this.element.scrollIntoView({ block: "nearest" });
  }

  /**
   * Excalidraw's zoom and scroll that draw the scene exactly where the static preview drew it:
   * the preview fits the scene's bounds plus padding into the box, centered.
   */
  private initialView(elements: readonly DrawingElement[], lib: ExcalidrawLib): DrawingView {
    const { x, y } = this.boxOffset;
    const bounds = lib.sceneBounds(elements);
    if (!bounds) return { zoom: 1, scrollX: x, scrollY: y };
    const box = this.options.host.dom.getBoundingClientRect();
    const pad = lib.RENDER_PADDING;
    const sceneWidth = bounds[2] - bounds[0] + 2 * pad;
    const sceneHeight = bounds[3] - bounds[1] + 2 * pad;
    const zoom = Math.min(
      Math.max(Math.min(box.width / sceneWidth, box.height / sceneHeight), 0.1),
      30,
    );
    const offsetX = (box.width - sceneWidth * zoom) / 2;
    const offsetY = (box.height - sceneHeight * zoom) / 2;
    return {
      zoom,
      scrollX: (x + offsetX) / zoom - (bounds[0] - pad),
      scrollY: (y + offsetY) / zoom - (bounds[1] - pad),
    };
  }

  /** Taller when the drawing nears the bottom edge. */
  private scheduleGrow(api: ExcalidrawImperativeAPI): void {
    if (this.growFrame) return;
    this.growFrame = requestAnimationFrame(() => {
      this.growFrame = 0;
      const editing = this.editing;
      if (!editing || this.closing) return;
      const bounds = editing.lib.sceneBounds(api.getSceneElements() as unknown as DrawingElement[]);
      if (!bounds) return;
      const { zoom, scrollY } = api.getAppState();
      const bottom = (bounds[3] + scrollY) * zoom.value;
      const height = this.element.getBoundingClientRect().height;
      if (bottom + GROW_MARGIN <= height - FOOTER_SPACE) return;
      const next = Math.min(bottom + GROW_MARGIN + FOOTER_SPACE, MAX_HEIGHT);
      if (next > height) this.element.style.height = `${Math.round(next)}px`;
    });
  }

  // ── Ending ──────────────────────────────────────────────────────────────

  private listen(): void {
    const signal = this.abort.signal;
    const doc = this.element.ownerDocument;
    // On the document: Escape also ends it while Excalidraw is still loading or lost the focus.
    // The app's own overlays (palette, menus) handle Escape first and prevent it.
    doc.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return;
        if (excalidrawWantsEscape(this.editing?.api ?? null)) return;
        event.preventDefault();
        event.stopPropagation();
        void this.close("escape");
      },
      { capture: true, signal },
    );
    doc.addEventListener(
      "pointerdown",
      (event) => {
        const target = event.target as Node | null;
        if (target && this.element.contains(target)) return;
        void this.close("outside");
      },
      { capture: true, signal },
    );
  }
}
