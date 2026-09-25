/**
 * The box an embed is drawn in: its placement (a float the text wraps around, or a row of its
 * own), its size, and what the user does with it: click to select, drag to move (to another line
 * or side), drag a corner to resize, Delete to remove, double-click or Enter to activate. The
 * content inside comes from the host's renderer.
 */
import { redo, undo } from "@codemirror/commands";
import { type EditorView, WidgetType } from "@codemirror/view";
import { dropTarget } from "./drop";
import { MIN_EMBED_WIDTH, moveEmbed, removeEmbed, resizeEmbed } from "./edits";
import { embedController, embedSelection, type MountedEmbed, selectEmbedEffect } from "./layer";
import { embedAt } from "./parse";
import type { BlockEmbed, EmbedContent, EmbedHost, EmbedRenderer } from "./types";

/** Movement before a press becomes a drag. */
const DRAG_THRESHOLD = 4;
/** Height of the empty box while the content hasn't reported its size. */
const PLACEHOLDER_HEIGHT = 160;
/** Width of a floated or aligned embed without a width or a natural size. */
const DEFAULT_WIDTH = 360;
/** Distance from the scroller's top or bottom edge where dragging scrolls. */
const AUTOSCROLL_EDGE = 40;

const mountedByFrame = new WeakMap<HTMLElement, Mounted>();

function sameTarget(a: BlockEmbed, b: BlockEmbed): boolean {
  return a.spec.target === b.spec.target && a.spec.subpath === b.spec.subpath;
}

/** Replaces an embed's `![[…]]` in the live preview. */
export class EmbedWidget extends WidgetType {
  readonly renderer: EmbedRenderer;
  readonly embed: BlockEmbed;
  readonly selected: boolean;
  readonly readOnly: boolean;

  constructor(renderer: EmbedRenderer, embed: BlockEmbed, selected: boolean, readOnly: boolean) {
    super();
    this.renderer = renderer;
    this.embed = embed;
    this.selected = selected;
    this.readOnly = readOnly;
  }

  override eq(other: EmbedWidget): boolean {
    return (
      other.renderer === this.renderer &&
      other.embed.text === this.embed.text &&
      other.selected === this.selected &&
      other.readOnly === this.readOnly
    );
  }

  toDOM(view: EditorView): HTMLElement {
    return new Mounted(view, this).frame;
  }

  override updateDOM(dom: HTMLElement): boolean {
    const mounted = mountedByFrame.get(dom);
    if (!mounted || mounted.renderer !== this.renderer || !sameTarget(mounted.embed, this.embed)) {
      return false;
    }
    return mounted.apply(this);
  }

  override destroy(dom: HTMLElement): void {
    mountedByFrame.get(dom)?.destroy();
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

interface Drag {
  pointerId: number;
  startX: number;
  startY: number;
  mode: "press" | "move" | "resize-start" | "resize-end";
  startWidth: number;
  maxWidth: number;
  width: number;
  indicator: HTMLElement | null;
  target: ReturnType<typeof dropTarget> | null;
}

class Mounted implements MountedEmbed {
  readonly view: EditorView;
  readonly renderer: EmbedRenderer;
  readonly frame: HTMLElement;
  readonly body: HTMLElement;
  embed: BlockEmbed;
  content: EmbedContent;
  private selected = false;
  private readOnly = false;
  private natural: { width: number; height: number } | null = null;
  private drag: Drag | null = null;
  private readonly abort = new AbortController();

  constructor(view: EditorView, widget: EmbedWidget) {
    this.view = view;
    this.renderer = widget.renderer;
    this.embed = widget.embed;
    const doc = view.dom.ownerDocument;
    this.frame = doc.createElement("div");
    this.frame.contentEditable = "false";
    this.frame.tabIndex = -1;
    this.frame.setAttribute("role", "figure");
    this.body = doc.createElement("div");
    this.body.className = "cm-ddl-embed-content";
    this.frame.append(
      this.body,
      handle(doc, "cm-ddl-embed-grip", "Drag to move"),
      handle(doc, "cm-ddl-embed-resize cm-ddl-embed-resize-start", "Drag to resize"),
      handle(doc, "cm-ddl-embed-resize cm-ddl-embed-resize-end", "Drag to resize"),
    );
    mountedByFrame.set(this.frame, this);
    this.apply(widget, true);
    const host: EmbedHost = {
      dom: this.body,
      view,
      spec: this.embed.spec,
      embed: () => {
        const from = this.position();
        return from === null ? null : embedAt(view.state.doc, from);
      },
      setNaturalSize: (size) => {
        this.natural = size && size.width > 0 && size.height > 0 ? size : null;
        this.layout();
      },
      select: () => this.select(),
    };
    this.content = this.mountContent(host);
    this.listen();
    view.plugin(embedController)?.mounted.add(this);
  }

  private mountContent(host: EmbedHost): EmbedContent {
    try {
      return this.renderer.mount(host);
    } catch (error) {
      this.body.textContent = "Couldn't show this embed";
      this.body.classList.add("cm-ddl-embed-error");
      queueMicrotask(() => {
        throw error;
      });
      return { destroy() {} };
    }
  }

  /** Takes a widget's new state; false when the content can't follow (then it's remounted). */
  apply(widget: EmbedWidget, initial = false): boolean {
    const specChanged = !initial && widget.embed.text !== this.embed.text;
    if (specChanged && !this.content.update?.(widget.embed.spec)) return false;
    this.embed = widget.embed;
    this.selected = widget.selected;
    this.readOnly = widget.readOnly;
    const { placement } = this.embed.spec;
    this.frame.className = [
      "cm-ddl-embed",
      `cm-ddl-embed-${this.renderer.kind}`,
      `cm-ddl-embed-${placement}`,
      this.selected ? "is-selected" : "",
      this.readOnly ? "is-readonly" : "",
    ]
      .filter(Boolean)
      .join(" ");
    this.layout();
    return true;
  }

  /** Width from the modifiers (else the natural width, else full or default); height from the content. */
  private layout(width?: number): void {
    const { spec } = this.embed;
    const style = this.frame.style;
    if (width !== undefined) style.width = `${width}px`;
    else if (spec.width !== undefined) style.width = `${spec.width}px`;
    else if (spec.widthPercent !== undefined) style.width = `${spec.widthPercent}%`;
    else if (spec.placement === "full") style.width = "100%";
    else style.width = `${Math.round(this.natural?.width ?? DEFAULT_WIDTH)}px`;
    const body = this.body.style;
    if (spec.height !== undefined) {
      const scale = width !== undefined && spec.width ? width / spec.width : 1;
      body.height = `${Math.round(spec.height * scale)}px`;
      body.aspectRatio = "";
    } else if (this.natural) {
      body.height = "";
      body.aspectRatio = `${this.natural.width} / ${this.natural.height}`;
    } else {
      body.height = `${PLACEHOLDER_HEIGHT}px`;
      body.aspectRatio = "";
    }
    // CodeMirror doesn't watch widgets' styles: tell it line heights may have changed.
    if (this.frame.isConnected) this.view.requestMeasure();
  }

  position(): number | null {
    if (!this.frame.isConnected) return null;
    try {
      const pos = this.view.posAtDOM(this.frame);
      return embedAt(this.view.state.doc, pos)?.from ?? null;
    } catch {
      return null;
    }
  }

  focus(): void {
    this.frame.focus({ preventScroll: true });
  }

  destroy(): void {
    this.abort.abort();
    this.endDrag(false);
    this.view.plugin(embedController)?.mounted.delete(this);
    mountedByFrame.delete(this.frame);
    try {
      this.content.destroy();
    } catch (error) {
      queueMicrotask(() => {
        throw error;
      });
    }
  }

  // ── Events ──────────────────────────────────────────────────────────────

  private listen(): void {
    const options = { signal: this.abort.signal };
    const frame = this.frame;
    // Keep the browser from moving the caret into the note or focusing the text.
    frame.addEventListener("mousedown", (event) => event.preventDefault(), options);
    frame.addEventListener("pointerdown", (event) => this.onPointerDown(event), options);
    frame.addEventListener("pointermove", (event) => this.onPointerMove(event), options);
    frame.addEventListener("pointerup", (event) => this.onPointerUp(event), options);
    frame.addEventListener("pointercancel", () => this.endDrag(false), options);
    frame.addEventListener("lostpointercapture", () => this.endDrag(false), options);
    frame.addEventListener("dblclick", (event) => this.onDoubleClick(event), options);
    frame.addEventListener("keydown", (event) => this.onKeyDown(event), options);
    frame.addEventListener("focusout", (event) => this.onFocusOut(event), options);
  }

  private select(): void {
    const from = this.position();
    if (from === null) return;
    if (this.view.state.field(embedSelection, false) !== from) {
      this.view.dispatch({ effects: selectEmbedEffect.of(from) });
    }
    this.focus();
  }

  private deselect(): void {
    this.view.dispatch({ effects: selectEmbedEffect.of(null) });
  }

  private onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || this.drag) return;
    event.preventDefault();
    this.select();
    if (this.readOnly) return;
    const target = event.target as Element;
    const mode = target.closest(".cm-ddl-embed-resize-start")
      ? "resize-start"
      : target.closest(".cm-ddl-embed-resize-end")
        ? "resize-end"
        : "press";
    this.frame.setPointerCapture(event.pointerId);
    this.drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      mode,
      startWidth: this.frame.getBoundingClientRect().width,
      maxWidth: this.columnWidth(),
      width: 0,
      indicator: null,
      target: null,
    };
    if (mode !== "press") this.frame.classList.add("is-resizing");
  }

  private onPointerMove(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (drag.mode === "press") {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      drag.mode = "move";
      this.frame.classList.add("is-dragging");
    }
    if (drag.mode === "move") {
      this.frame.style.transform = `translate(${dx}px, ${dy}px)`;
      this.autoscroll(event.clientY);
      this.showDropTarget(drag);
      return;
    }
    const factor = this.embed.spec.placement === "center" ? 2 : 1;
    const delta = (drag.mode === "resize-start" ? -dx : dx) * factor;
    drag.width = Math.round(
      Math.min(Math.max(drag.startWidth + delta, MIN_EMBED_WIDTH), drag.maxWidth),
    );
    this.layout(drag.width);
    this.view.requestMeasure();
  }

  private onPointerUp(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    this.endDrag(true);
  }

  /** Ends a press, move or resize; `commit` applies it to the note. */
  private endDrag(commit: boolean): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    drag.indicator?.remove();
    this.frame.classList.remove("is-dragging", "is-resizing");
    this.frame.style.transform = "";
    if (this.frame.hasPointerCapture(drag.pointerId)) {
      this.frame.releasePointerCapture(drag.pointerId);
    }
    const from = this.position();
    const embed = from === null ? null : embedAt(this.view.state.doc, from);
    if (!commit || !embed || drag.mode === "press") {
      if (drag.mode.startsWith("resize")) this.layout();
      return;
    }
    const edit =
      drag.mode === "move"
        ? drag.target && moveEmbed(this.view.state, embed, drag.target)
        : resizeEmbed(embed, drag.width || drag.startWidth);
    if (!edit) {
      this.layout();
      return;
    }
    this.view.dispatch({
      ...edit.spec,
      effects: selectEmbedEffect.of(edit.from),
    });
  }

  private onDoubleClick(event: MouseEvent): void {
    event.preventDefault();
    this.content.activate?.();
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.target !== this.frame || event.isComposing) return;
    if (this.drag && this.drag.mode !== "press") {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.endDrag(false);
      }
      return;
    }
    const mod = event.metaKey || event.ctrlKey;
    const from = this.position();
    const embed = from === null ? null : embedAt(this.view.state.doc, from);
    switch (event.key) {
      case "Enter":
        if (mod || event.altKey) break;
        event.preventDefault();
        this.content.activate?.();
        return;
      case "Delete":
      case "Backspace":
        if (this.readOnly || !embed) break;
        event.preventDefault();
        this.view.dispatch(removeEmbed(this.view.state, embed));
        this.view.focus();
        return;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        this.deselect();
        this.view.focus();
        return;
      case "ArrowUp":
      case "ArrowLeft":
      case "ArrowDown":
      case "ArrowRight": {
        if (!embed) break;
        event.preventDefault();
        const doc = this.view.state.doc;
        const back = event.key === "ArrowUp" || event.key === "ArrowLeft";
        const line = doc.lineAt(embed.lineFrom);
        const anchor = back
          ? line.number > 1
            ? doc.line(line.number - 1).to
            : line.from
          : line.number < doc.lines
            ? doc.line(line.number + 1).from
            : line.to;
        this.view.dispatch({ selection: { anchor }, scrollIntoView: true });
        this.view.focus();
        return;
      }
      default:
        break;
    }
    if (mod && !event.altKey && event.key.toLowerCase() === "z") {
      event.preventDefault();
      this.view.focus();
      (event.shiftKey ? redo : undo)(this.view);
      return;
    }
    // Anything else goes to the note: typing starts at the caret.
    if (!mod && event.key.length === 1) {
      this.deselect();
      this.view.focus();
    }
  }

  private onFocusOut(event: FocusEvent): void {
    const next = event.relatedTarget as Node | null;
    if (next && this.frame.contains(next)) return;
    // Later: focus can leave while CodeMirror updates the DOM, where dispatching isn't allowed.
    setTimeout(() => {
      if (this.drag || this.frame.contains(this.view.root.activeElement)) return;
      const from = this.position();
      if (from !== null && this.view.state.field(embedSelection, false) === from) {
        this.deselect();
      }
    }, 0);
  }

  // ── Dragging ────────────────────────────────────────────────────────────

  /** The text column's width, the most an embed can take. */
  private columnWidth(): number {
    const content = this.view.contentDOM;
    const style = getComputedStyle(content);
    return (
      content.clientWidth -
      Number.parseFloat(style.paddingLeft || "0") -
      Number.parseFloat(style.paddingRight || "0")
    );
  }

  /**
   * Where the dragged box (following the pointer) would land: its top edge picks the line, its
   * center the side, so a small move never jumps far and dropping in place changes nothing.
   */
  private showDropTarget(drag: Drag): void {
    const view = this.view;
    const content = view.contentDOM;
    const rect = content.getBoundingClientRect();
    const style = getComputedStyle(content);
    const left = rect.left + Number.parseFloat(style.paddingLeft || "0");
    const right = rect.right - Number.parseFloat(style.paddingRight || "0");
    const doc = view.state.doc;
    const ghost = this.frame.getBoundingClientRect();
    const target = dropTarget(
      { x: ghost.left + ghost.width / 2, y: ghost.top - view.documentTop },
      {
        lineAt: (y) => {
          const block = view.lineBlockAtHeight(Math.max(0, y));
          return { index: doc.lineAt(block.from).number - 1, top: block.top, bottom: block.bottom };
        },
        lineCount: doc.lines,
        left,
        right,
      },
    );
    drag.target = target;
    const scroller = view.scrollDOM;
    const scrollerRect = scroller.getBoundingClientRect();
    let indicator = drag.indicator;
    if (!indicator) {
      indicator = scroller.ownerDocument.createElement("div");
      indicator.className = "cm-ddl-embed-drop";
      indicator.setAttribute("aria-hidden", "true");
      indicator.append(scroller.ownerDocument.createElement("div"));
      scroller.appendChild(indicator);
      drag.indicator = indicator;
    }
    const columnWidth = right - left;
    const width = target.placement === "full" ? columnWidth : Math.min(ghost.width, columnWidth);
    const x = target.placement === "right-wrap" ? right - width : left;
    indicator.dataset.placement = target.placement;
    Object.assign(indicator.style, {
      left: `${left - scrollerRect.left + scroller.scrollLeft}px`,
      top: `${view.documentTop + target.y - scrollerRect.top + scroller.scrollTop}px`,
      width: `${columnWidth}px`,
    });
    const preview = indicator.firstElementChild as HTMLElement;
    Object.assign(preview.style, {
      left: `${x - left}px`,
      width: `${width}px`,
      height: `${target.placement === "full" ? (ghost.height * columnWidth) / ghost.width : ghost.height}px`,
    });
  }

  private autoscroll(clientY: number): void {
    const scroller = this.view.scrollDOM;
    const rect = scroller.getBoundingClientRect();
    if (clientY < rect.top + AUTOSCROLL_EDGE) scroller.scrollTop -= 12;
    else if (clientY > rect.bottom - AUTOSCROLL_EDGE) scroller.scrollTop += 12;
  }
}

function handle(doc: Document, className: string, tooltip: string): HTMLElement {
  const element = doc.createElement("span");
  element.className = className;
  element.dataset.tooltip = tooltip;
  element.setAttribute("aria-hidden", "true");
  return element;
}
