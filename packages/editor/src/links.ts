/**
 * Link resolution and following: wikilinks, inline/auto links and bare URLs, via the syntax tree.
 */
import { syntaxTree } from "@codemirror/language";
import type { EditorState, StateCommand } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { annotationAtLine } from "./annotations/field";
import { editorCallbacks } from "./callbacks";
import { splitWikiLink } from "./syntax/markdown-extensions";

type SyntaxNode = ReturnType<typeof syntaxTree>["topNode"];

export type LinkTarget =
  | { kind: "wiki"; target: string; subpath?: string; from: number; to: number }
  | { kind: "external"; url: string; from: number; to: number };

/** Class names the live preview puts on rendered (syntax-hidden) link text. */
export const RENDERED_LINK_CLASS = "cm-ddl-link";
export const RENDERED_WIKILINK_CLASS = "cm-ddl-wikilink";

const SCHEME_RE = /^([a-z][a-z\d+.-]*):/i;
// Anything else (javascript:, data:, file:, …) is never handed to the host.
const SAFE_SCHEMES = new Set(["http", "https", "mailto", "tel"]);
const EMAIL_RE = /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/;
const LINK_CONTAINERS = new Set(["Link", "Image", "Autolink"]);

/** The link at `pos` (preferring the node after it), or null. */
export function findLinkAt(state: EditorState, pos: number): LinkTarget | null {
  const tree = syntaxTree(state);
  return (
    linkFromNode(state, tree.resolveInner(pos, 1)) ??
    linkFromNode(state, tree.resolveInner(pos, -1))
  );
}

function linkFromNode(state: EditorState, start: SyntaxNode): LinkTarget | null {
  for (let node: SyntaxNode | null = start; node; node = node.parent) {
    switch (node.name) {
      case "WikiLink":
        return wikiLinkTarget(state, node);
      case "Link":
      case "Autolink": {
        const url = node.getChild("URL");
        return url ? urlTarget(state.sliceDoc(url.from, url.to), node.from, node.to) : null;
      }
      case "URL":
        if (!node.parent || !LINK_CONTAINERS.has(node.parent.name)) {
          return urlTarget(state.sliceDoc(node.from, node.to), node.from, node.to);
        }
        break;
      case "Image":
        return null;
    }
  }
  return null;
}

function wikiLinkTarget(state: EditorState, node: SyntaxNode): LinkTarget | null {
  const target = node.getChild("WikiLinkTarget");
  if (!target) return null;
  const { target: note, subpath } = splitWikiLink(state.sliceDoc(target.from, target.to));
  return subpath
    ? { kind: "wiki", target: note, subpath, from: node.from, to: node.to }
    : { kind: "wiki", target: note, from: node.from, to: node.to };
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * Classifies a link destination: safe absolute URLs and `www.`/email autolinks are external;
 * scheme-less destinations (`[x](Daily/2026-06-19.md#Tasks)`) are note links, like in Obsidian.
 */
export function urlTarget(raw: string, from: number, to: number): LinkTarget | null {
  const url = raw.startsWith("<") && raw.endsWith(">") ? raw.slice(1, -1).trim() : raw.trim();
  if (!url) return null;
  const scheme = SCHEME_RE.exec(url)?.[1]?.toLowerCase();
  if (scheme !== undefined) {
    return SAFE_SCHEMES.has(scheme) ? { kind: "external", url, from, to } : null;
  }
  if (/^www\./i.test(url)) return { kind: "external", url: `https://${url}`, from, to };
  if (url.startsWith("//")) return { kind: "external", url: `https:${url}`, from, to };
  if (EMAIL_RE.test(url)) return { kind: "external", url: `mailto:${url}`, from, to };
  const hash = url.indexOf("#");
  const target = safeDecode(hash < 0 ? url : url.slice(0, hash));
  const subpath = hash < 0 ? "" : safeDecode(url.slice(hash + 1));
  return subpath ? { kind: "wiki", target, subpath, from, to } : { kind: "wiki", target, from, to };
}

export function openLink(state: EditorState, link: LinkTarget, newPane: boolean): void {
  const callbacks = state.facet(editorCallbacks);
  if (link.kind === "external") {
    callbacks.onExternalLinkClick?.(link.url);
  } else {
    callbacks.onWikiLinkClick?.(
      link.target,
      link.subpath === undefined ? { newPane } : { newPane, subpath: link.subpath },
    );
  }
}

/** Alt-Enter: follow the link at the cursor, or open the agent thread of the cursor's line. */
export const followLinkAtCursor: StateCommand = ({ state }) => {
  const head = state.selection.main.head;
  const link = findLinkAt(state, head);
  if (link) {
    openLink(state, link, false);
    return true;
  }
  const annotation = annotationAtLine(state, state.doc.lineAt(head).number - 1);
  if (!annotation) return false;
  state.facet(editorCallbacks).onAnnotationClick?.(annotation);
  return true;
};

const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform ?? "");

function closestElement(target: EventTarget | null, selector: string): Element | null {
  const el = target as Element | null;
  return el && typeof el.closest === "function" ? el.closest(selector) : null;
}

/**
 * A plain click follows links whose syntax is hidden (rendered by the live preview, i.e. not being
 * edited); Mod-click follows any link and opens wikilinks in a new pane, as does a middle click.
 */
export const linkClickHandler = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0 && event.button !== 1) return false;
    const mod = IS_MAC ? event.metaKey : event.ctrlKey;
    const middle = event.button === 1;
    const rendered = closestElement(
      event.target,
      `.${RENDERED_LINK_CLASS}, .${RENDERED_WIKILINK_CLASS}`,
    );
    if (!rendered && !mod && !middle) return false;
    const pos = rendered
      ? view.posAtDOM(rendered)
      : view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos === null) return false;
    const link = findLinkAt(view.state, pos);
    if (!link) return false;
    event.preventDefault();
    openLink(view.state, link, mod || middle);
    return true;
  },
});
