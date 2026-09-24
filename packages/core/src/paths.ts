/**
 * Vault-relative path helpers. Vault paths are always POSIX-style, relative to the vault root,
 * with no leading slash and no `.`/`..` segments (e.g. `Daily/2026-09-23.md`).
 */

/** Hidden sidecar directory inside the vault that holds agent threads, artifacts and state. */
export const SIDECAR_DIR = ".daily-do-list";

export class InvalidPathError extends Error {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`Invalid vault path "${path}": ${reason}`);
    this.name = "InvalidPathError";
    this.path = path;
  }
}

/** Normalizes a user/agent supplied path into canonical vault form. Throws on escapes. */
export function normalizePath(input: string): string {
  if (input.includes("\0")) throw new InvalidPathError(input, "contains a NUL byte");
  const segments: string[] = [];
  for (const segment of input.replace(/\\/g, "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) throw new InvalidPathError(input, "escapes the vault root");
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

/** True when `input` normalizes cleanly and stays inside the vault. */
export function isSafeVaultPath(input: string): boolean {
  try {
    return normalizePath(input).length > 0;
  } catch {
    return false;
  }
}

export function joinPath(...parts: string[]): string {
  return normalizePath(parts.filter((p) => p.length > 0).join("/"));
}

export function dirname(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

export function basename(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

/** Extension including the dot (`.md`), or `""`. Dotfiles like `.env` have no extension. */
export function extname(path: string): string {
  const base = basename(path);
  const idx = base.lastIndexOf(".");
  return idx <= 0 ? "" : base.slice(idx);
}

/** File name without extension: `Daily/2026-09-23.md` → `2026-09-23`. */
export function stem(path: string): string {
  const base = basename(path);
  const ext = extname(base);
  return ext ? base.slice(0, -ext.length) : base;
}

export function isMarkdownPath(path: string): boolean {
  return extname(path).toLowerCase() === ".md";
}

export function ensureMarkdownExtension(path: string): string {
  return isMarkdownPath(path) ? path : `${path}.md`;
}

/** True if any segment is a dotfile/dotfolder (`.obsidian`, `.git`, the sidecar dir, …). */
export function isHiddenPath(path: string): boolean {
  return path.split("/").some((segment) => segment.startsWith("."));
}

export function isSidecarPath(path: string): boolean {
  return path === SIDECAR_DIR || path.startsWith(`${SIDECAR_DIR}/`);
}

/** Returns every ancestor folder of a path, outermost first: `a/b/c.md` → [`a`, `a/b`]. */
export function ancestorFolders(path: string): string[] {
  const parts = path.split("/");
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

/** Sort comparator matching Obsidian's explorer: folders first, then case-insensitive natural order. */
export function compareVaultPaths(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}
