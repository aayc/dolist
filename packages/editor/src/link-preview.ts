/**
 * Hover cards for links. A web link shows what the agent saw of the page (a cited source the
 * host passes in) or else its label, host and address; a note link shows the start of the note.
 * Nothing here fetches a link: previews only use data the host already has.
 *
 * The card is a small fixed-position popover rather than CodeMirror's tooltip system, which would
 * add ~4 kB (gzip) to the app's startup bundle for this one use.
 */
import type { EditorState } from "@codemirror/state";
import { type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { type CitedSource, parseAgentLine } from "@ddl/core";
import { editorCallbacks } from "./callbacks";
import { type LinkTarget, linkAt } from "./links";
import type { LinkPreview } from "./types";

const HOVER_MS = 300;
const GAP = 6;
const MARGIN = 8;
/** Citation labels (`[1](url)`) say nothing about the page. */
const NUMERIC_LABEL = /^\d{1,4}$/;

/** `example.com` for `https://www.example.com/x`; empty for links without a web host. */
export function hostnameOf(url: string): string {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol !== "http:" && protocol !== "https:") return "";
    return hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

/** A web link's card: its cited source's title and snippet, else its label (or host) and URL. */
export function webLinkPreview(
  url: string,
  label: string,
  source?: CitedSource | null,
): LinkPreview {
  const hostname = hostnameOf(url);
  const text = label.trim();
  const fallback =
    text && text !== url && !NUMERIC_LABEL.test(text)
      ? text
      : hostname || url.replace(/^(?:mailto|tel):/i, "");
  const snippet = source?.snippet?.trim();
  return {
    kind: "web",
    url,
    title: source?.title?.trim() || fallback,
    hostname,
    ...(snippet ? { snippet } : {}),
  };
}

/** The card's DOM (plain text only). */
export function renderLinkPreview(doc: Document, preview: LinkPreview): HTMLElement {
  const root = doc.createElement("div");
  root.className = `cm-ddl-link-preview cm-ddl-link-preview-${preview.kind}`;
  const part = (parent: HTMLElement, tag: string, name: string, text: string) => {
    const el = parent.appendChild(doc.createElement(tag));
    el.className = `cm-ddl-link-preview-${name}`;
    el.textContent = text;
    return el;
  };
  part(root, "div", "title", preview.title);
  if (preview.kind === "web") {
    if (preview.hostname) part(root, "div", "host", preview.hostname);
    if (preview.snippet) part(root, "p", "snippet", preview.snippet);
    part(root, "div", "url", preview.url);
  } else if (preview.missing || preview.lines.length === 0) {
    part(root, "div", "empty", preview.missing ? "No note with this name yet" : "Empty note");
  } else {
    const body = part(root, "div", "lines", "");
    for (const line of preview.lines) part(body, "div", "line", line);
  }
  return root;
}

/** Where a popover goes: under `bottom` (over `top` when there's no room), from `left`. */
export interface PopoverAnchor {
  left: number;
  top: number;
  bottom: number;
}

/**
 * A floating link preview card in the document's body, kept inside the window. The editor and
 * the app's agent views share it, so previews look the same everywhere.
 */
export class LinkPopover {
  private readonly doc: Document;
  private card: HTMLElement | null = null;

  constructor(doc: Document) {
    this.doc = doc;
  }

  show(preview: LinkPreview, anchor: PopoverAnchor): void {
    this.hide();
    const card = this.doc.createElement("div");
    card.className = "cm-ddl-link-popover";
    card.setAttribute("role", "tooltip");
    card.append(renderLinkPreview(this.doc, preview));
    this.doc.body.append(card);
    const { width, height } = card.getBoundingClientRect();
    const view = this.doc.defaultView;
    const maxX = (view?.innerWidth ?? width + 2 * MARGIN) - width - MARGIN;
    const maxY = (view?.innerHeight ?? Number.POSITIVE_INFINITY) - MARGIN;
    const below = anchor.bottom + GAP;
    const top = below + height <= maxY ? below : Math.max(MARGIN, anchor.top - GAP - height);
    card.style.top = `${top}px`;
    card.style.left = `${Math.max(MARGIN, Math.min(anchor.left, maxX))}px`;
    this.card = card;
  }

  hide(): void {
    this.card?.remove();
    this.card = null;
  }
}

/**
 * The preview of the link on the given side of `pos`: asked of the host (with the thread named
 * by the line's agent marker), else the web fallback. Null away from links, or for a note link
 * the host has nothing for.
 */
export async function linkPreviewAt(
  state: EditorState,
  pos: number,
  side: -1 | 1,
): Promise<{ link: LinkTarget; preview: LinkPreview } | null> {
  const found = linkAt(state, pos, side);
  if (!found) return null;
  const { link, label } = found;
  const threadId = parseAgentLine(state.doc.lineAt(pos).text)?.threadId ?? null;
  let preview: LinkPreview | null = null;
  try {
    preview =
      (await state.facet(editorCallbacks).onLinkPreview?.({ link, label, threadId })) ?? null;
  } catch {
    preview = null;
  }
  if (!preview && link.kind === "external") preview = webLinkPreview(link.url, label);
  return preview ? { link, preview } : null;
}

/** Shows a link's preview after the mouse rests on it; an edit, a caret move or a scroll hides it. */
class LinkHover {
  private readonly view: EditorView;
  private readonly popover: LinkPopover;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private shown: { from: number; to: number } | null = null;
  private request = 0;
  private readonly onScroll = () => this.hide();

  constructor(view: EditorView) {
    this.view = view;
    this.popover = new LinkPopover(view.dom.ownerDocument);
    view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.selectionSet || update.geometryChanged) this.hide();
  }

  move(event: MouseEvent): void {
    const { clientX: x, clientY: y } = event;
    if (this.shown) {
      const pos = this.view.posAtCoords({ x, y });
      if (pos !== null && pos >= this.shown.from && pos <= this.shown.to) return;
    }
    this.hide();
    this.timer = setTimeout(() => void this.check(x, y), HOVER_MS);
  }

  hide(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.request++;
    this.shown = null;
    this.popover.hide();
  }

  destroy(): void {
    this.hide();
    this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
  }

  private async check(x: number, y: number): Promise<void> {
    const { view } = this;
    const pos = view.posAtCoords({ x, y });
    const at = pos === null ? null : view.coordsAtPos(pos);
    const slack = view.defaultCharacterWidth;
    if (pos === null || !at || y < at.top || y > at.bottom) return;
    if (x < at.left - slack || x > at.right + slack) return;
    const request = ++this.request;
    const found = await linkPreviewAt(view.state, pos, x < at.left ? -1 : 1);
    if (!found || request !== this.request) return;
    const start = view.coordsAtPos(found.link.from, 1);
    const end = view.coordsAtPos(found.link.to, -1);
    if (!start || !end) return;
    this.shown = { from: found.link.from, to: found.link.to };
    this.popover.show(found.preview, { left: start.left, top: start.top, bottom: end.bottom });
  }
}

export const linkPreviews = ViewPlugin.fromClass(LinkHover, {
  // Observers, not handlers: they see events other handlers (keymaps, link clicks) consume.
  eventObservers: {
    mousemove(event) {
      this.move(event);
    },
    mouseleave() {
      this.hide();
    },
    mousedown() {
      this.hide();
    },
    keydown() {
      this.hide();
    },
  },
});
