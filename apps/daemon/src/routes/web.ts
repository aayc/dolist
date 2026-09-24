import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import type { Context, Hono } from "hono";
import type { AppContext } from "../context";
import type { SecurityPolicy } from "../security";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
};

/** Vite emits content-hashed files under `assets/`; they never change and can be cached forever. */
const HASHED_ASSETS_PREFIX = "/assets/";
const IMMUTABLE = "public, max-age=31536000, immutable";
const INLINE_SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const HEAD_TAG_RE = /<head(?:\s[^>]*)?>/i;

interface IndexDocument {
  mtimeMs: number;
  size: number;
  html: string;
  csp: string;
}

/**
 * Serves the built web UI with an SPA fallback. index.html is rendered per request with the bearer
 * token in `<meta name="ddl-token">`, so it is never cached and relies on the Host allowlist to stay
 * unreadable from other origins (DNS rebinding).
 */
export function registerWebRoutes(app: Hono, ctx: AppContext): void {
  if (ctx.webDist === null) return;
  const root = resolve(ctx.webDist);
  const indexPath = join(root, "index.html");
  let cached: IndexDocument | null = null;

  const loadIndex = async (): Promise<IndexDocument | null> => {
    const info = await stat(indexPath).catch(() => null);
    if (!info?.isFile()) return null;
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached;
    const source = await readFile(indexPath, "utf8");
    cached = {
      mtimeMs: info.mtimeMs,
      size: info.size,
      html: injectToken(source, ctx.token),
      csp: appContentSecurityPolicy(inlineScriptHashes(source), ctx.policy),
    };
    return cached;
  };

  app.get("*", async (c) => {
    const pathname = new URL(c.req.url).pathname;
    const index = await loadIndex();
    if (!index) return isStaticAssetPath(pathname) ? c.text("Not found", 404) : missingBuild(c);
    if (pathname === "/" || pathname === "/index.html") return serveIndex(c, index);
    const file = resolveStaticFile(root, pathname);
    if (file) {
      const response = await serveFile(c, file, pathname);
      if (response) return response;
    }
    return isStaticAssetPath(pathname) ? c.text("Not found", 404) : serveIndex(c, index);
  });
}

export function injectToken(html: string, token: string): string {
  const meta = `<meta name="ddl-token" content="${escapeAttribute(token)}">`;
  const head = HEAD_TAG_RE.exec(html);
  if (!head) return `${meta}${html}`;
  const at = head.index + head[0].length;
  return `${html.slice(0, at)}${meta}${html.slice(at)}`;
}

/** CSP hashes for inline `<script>` blocks (e.g. the flash-free theme bootstrap). */
export function inlineScriptHashes(html: string): string[] {
  const hashes = new Set<string>();
  for (const match of html.matchAll(INLINE_SCRIPT_RE)) {
    if (/\bsrc\s*=/i.test(match[1] ?? "")) continue;
    hashes.add(
      `'sha256-${createHash("sha256")
        .update(match[2] ?? "", "utf8")
        .digest("base64")}'`,
    );
  }
  return [...hashes];
}

export function appContentSecurityPolicy(scriptHashes: string[], policy: SecurityPolicy): string {
  const sockets = [`ws://127.0.0.1:${policy.port}`, `ws://localhost:${policy.port}`];
  return [
    "default-src 'self'",
    ["script-src 'self'", ...scriptHashes].join(" "),
    // CodeMirror injects <style> elements at runtime.
    "style-src 'self' 'unsafe-inline'",
    // data: for live surface frames, blob: for artifacts fetched with the bearer token.
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    ["connect-src 'self'", ...sockets].join(" "),
    "frame-src 'self' blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

function serveIndex(c: Context, index: IndexDocument): Response {
  return c.html(index.html, 200, {
    ...documentHeaders(index.csp),
    "Cache-Control": "no-store",
  });
}

async function serveFile(c: Context, file: string, pathname: string): Promise<Response | null> {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return null;
  const ext = extname(file).toLowerCase();
  const contentType = Object.hasOwn(CONTENT_TYPES, ext)
    ? CONTENT_TYPES[ext]!
    : "application/octet-stream";
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Cache-Control": pathname.startsWith(HASHED_ASSETS_PREFIX) ? IMMUTABLE : "no-cache",
  };
  if (ext === ".html")
    Object.assign(headers, documentHeaders("default-src 'self'; frame-ancestors 'none'"));
  return c.body(await readFile(file), 200, headers);
}

function missingBuild(c: Context): Response {
  const csp =
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
  return c.html(MISSING_BUILD_PAGE, 503, { ...documentHeaders(csp), "Cache-Control": "no-store" });
}

function documentHeaders(csp: string): Record<string, string> {
  return {
    "Content-Security-Policy": csp,
    "X-Frame-Options": "DENY",
    "Cross-Origin-Opener-Policy": "same-origin",
  };
}

/** Maps a URL path to a file inside `root`; rejects traversal, dot-files and malformed escapes. */
function resolveStaticFile(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const segments = decoded.split("/").filter((segment) => segment !== "");
  if (segments.length === 0 || segments.some((segment) => segment.startsWith("."))) return null;
  const file = resolve(root, ...segments);
  return file.startsWith(`${root}${sep}`) ? file : null;
}

/** Paths that must 404 when missing instead of falling back to index.html. */
function isStaticAssetPath(pathname: string): boolean {
  const ext = extname(pathname).toLowerCase();
  return (
    pathname.startsWith(HASHED_ASSETS_PREFIX) ||
    (Object.hasOwn(CONTENT_TYPES, ext) && ext !== ".html")
  );
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

const MISSING_BUILD_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Daily Do List</title>
<style>
  body { font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: #0e1116; color: #f2f5f9; }
  main { max-width: 36rem; margin: 15vh auto; padding: 0 1.5rem; }
  code { background: #1a2029; padding: 0.1rem 0.35rem; border-radius: 4px; }
  a { color: #5ca0ff; }
</style>
</head>
<body>
<main>
<h1>The web app has not been built</h1>
<p>The daemon is running, but there is no built UI to serve.</p>
<p>Build it with <code>pnpm build</code> and reload this page, or run <code>pnpm dev</code> and open the Vite dev server at <a href="http://localhost:5173">http://localhost:5173</a>.</p>
</main>
</body>
</html>
`;
