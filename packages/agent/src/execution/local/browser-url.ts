import { NavigationBlockedError } from "../errors";

const HAS_AUTHORITY = /^[a-z][a-z0-9+.-]*:\/\//i;
/** Schemes written without `//` that must be recognized (and refused) rather than prefixed. */
const OPAQUE_SCHEME =
  /^(?:about|blob|chrome|chrome-extension|chrome-untrusted|data|devtools|edge|file|filesystem|intent|javascript|mailto|sms|tel|vbscript|view-source):/i;
const LOOPBACK_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/?#]|$)/i;

/**
 * Normalizes a model-supplied URL and enforces the navigation policy: only http(s) pages and
 * `about:blank`. Bare hosts get `https://` (`http://` for loopback dev servers).
 */
export function normalizeNavigationUrl(input: string): URL {
  const raw = input.trim();
  if (!raw) throw new NavigationBlockedError("URL is empty.");
  let candidate = raw;
  if (!HAS_AUTHORITY.test(raw) && !OPAQUE_SCHEME.test(raw)) {
    candidate = `${LOOPBACK_HOST.test(raw) ? "http" : "https"}://${raw}`;
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new NavigationBlockedError(`Not a valid URL: ${truncate(raw)}`);
  }
  if (url.protocol === "http:" || url.protocol === "https:") return url;
  if (url.href === "about:blank") return url;
  throw new NavigationBlockedError(
    `Refusing to open a ${url.protocol} URL. Only http(s) pages (or about:blank) can be opened in the browser.`,
  );
}

function truncate(text: string, max = 120): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
