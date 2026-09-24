import DOMPurify from "dompurify";
import { Marked } from "marked";

const marked = new Marked({ gfm: true, breaks: true, async: false });
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
    if (href.startsWith("#")) return;
    el.setAttribute("target", "_blank");
    el.setAttribute("rel", "noopener noreferrer");
  });
}

/** Markdown → sanitized HTML (links open in a new tab). Results are memoized by source text. */
export function renderMarkdown(source: string): string {
  const hit = cache.get(source);
  if (hit !== undefined) return hit;
  installHooks();
  const html = DOMPurify.sanitize(marked.parse(source, { async: false }), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "form", "button", "textarea", "select"],
  });
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(source, html);
  return html;
}
