import DOMPurify from "dompurify";
import { Marked, type TokenizerAndRendererExtension, type Tokens } from "marked";

const WIKILINK_RE = /^!?\[\[([^[\]\n|]+)(?:\|([^[\]\n]*))?\]\]/;
/** A link whose text is only a number (`[1](https://…)`) is a citation. */
const CITATION_TEXT = /^\d{1,3}$/;

interface WikiLinkToken extends Tokens.Generic {
  type: "wikilink";
  target: string;
  subpath: string;
  label: string;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * `[[Note]]`, `[[Note#Heading|label]]` (and `![[embeds]]`, shown as links) become links carrying
 * the note in `data-wikilink`; the thread view opens them in the editor. Same-note links
 * (`[[#Heading]]`) stay text.
 */
export const wikiLinks: TokenizerAndRendererExtension = {
  name: "wikilink",
  level: "inline",
  start(src) {
    const at = src.indexOf("[[");
    if (at === -1) return undefined;
    return at > 0 && src[at - 1] === "!" ? at - 1 : at;
  },
  tokenizer(src) {
    const match = WIKILINK_RE.exec(src);
    if (!match) return undefined;
    const inner = match[1]!.trim();
    const hash = inner.indexOf("#");
    const target = (hash === -1 ? inner : inner.slice(0, hash)).trim();
    if (!target) return undefined;
    const token: WikiLinkToken = {
      type: "wikilink",
      raw: match[0],
      target,
      subpath: hash === -1 ? "" : inner.slice(hash + 1).trim(),
      label: match[2]?.trim() || inner,
    };
    return token;
  },
  renderer(token) {
    const { target, subpath, label } = token as WikiLinkToken;
    const sub = subpath ? ` data-subpath="${escapeHtml(subpath)}"` : "";
    return `<a href="#" data-wikilink="${escapeHtml(target)}"${sub}>${escapeHtml(label)}</a>`;
  },
};

const marked = new Marked({ gfm: true, breaks: true, async: false, extensions: [wikiLinks] });
const cache = new Map<string, string>();
const CACHE_MAX = 300;
let hooksInstalled = false;

function installHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if ((node as Element).tagName !== "A") return;
    const el = node as Element;
    const href = el.getAttribute("href") ?? "";
    if (/^https?:/i.test(href) && CITATION_TEXT.test(el.textContent?.trim() ?? "")) {
      el.setAttribute("data-cite", "");
    } else {
      el.removeAttribute("data-cite");
    }
    if (href.startsWith("#")) return;
    el.setAttribute("target", "_blank");
    el.setAttribute("rel", "noopener noreferrer");
  });
}

/**
 * Markdown → sanitized HTML (links open in a new tab; numbered links get `data-cite`, wikilinks
 * `data-wikilink`). Results are memoized by source text.
 */
export function renderMarkdown(source: string): string {
  const hit = cache.get(source);
  if (hit !== undefined) return hit;
  installHooks();
  const html = DOMPurify.sanitize(marked.parse(source, { async: false }), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "form", "button", "textarea", "select", "template"],
    // Agent text can quote untrusted pages: no inline styles, app classes or ids, so it can't
    // escape its message (a fixed full-window overlay over the approval buttons) or pose as app UI,
    // nor app tooltips (links already preview their page on hover).
    FORBID_ATTR: [
      "style",
      "class",
      "id",
      "title",
      "data-tooltip",
      "data-command",
      "data-tooltip-keys",
      "data-tooltip-overflow",
      "data-tooltip-placement",
    ],
  });
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(source, html);
  return html;
}
