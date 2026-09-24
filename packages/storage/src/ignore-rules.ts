import { basename, createId, normalizePath } from "@ddl/core";

/** Folder/file names that are never part of the vault, at any depth. */
export const ALWAYS_IGNORED_NAMES: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  ".trash",
  ".DS_Store",
]);

const TEMP_PREFIX = ".ddl-tmp-";

/**
 * Transient files other programs create next to a note while saving it. Hiding them keeps the
 * tree clean and lets the watcher collapse an editor's atomic save into one `modified` event.
 */
const EDITOR_TEMP_PATTERNS: readonly RegExp[] = [
  /~$/, // vim/emacs backups
  /\.sw[nopx]$/, // vim swap files
  /^\.#/, // emacs lock files
  /^4913$/, // vim's directory write probe
  /\.crswap$/, // Chromium File System Access API
  /___jb_(?:tmp|old|bak)___$/, // JetBrains safe write
  /\.sb-[0-9a-f]+-[A-Za-z0-9]+$/, // macOS NSDocument safe save
  /^\..+\.tmp$/, // hidden `.tmp` files (Syncthing and friends)
];

/** Name for a storage-owned temporary file (hidden, so other apps skip it too). */
export function createTempFileName(): string {
  return `${TEMP_PREFIX}${createId(undefined, 12)}`;
}

export function isStorageTempName(name: string): boolean {
  return name.startsWith(TEMP_PREFIX);
}

/** True for temp files written by a storage provider (never listed, watched or synced). */
export function isStorageTempPath(path: string): boolean {
  return isStorageTempName(basename(path));
}

export function isEditorTempName(name: string): boolean {
  return EDITOR_TEMP_PATTERNS.some((re) => re.test(name));
}

/** True when `path` equals `prefix` or lives below it (`prefix: ""` matches everything). */
export function isUnderPrefix(path: string, prefix: string): boolean {
  return prefix === "" || path === prefix || path.startsWith(`${prefix}/`);
}

/** Vault paths that list/watch skip: always-ignored names, temp files and extra prefixes. */
export class IgnoreRules {
  private readonly prefixes: readonly string[];

  constructor(extraPrefixes: readonly string[] = []) {
    this.prefixes = extraPrefixes.map((p) => normalizePath(p)).filter((p) => p.length > 0);
  }

  isIgnored(path: string): boolean {
    const segments = path.split("/");
    if (segments.some((segment) => ALWAYS_IGNORED_NAMES.has(segment))) return true;
    const name = segments[segments.length - 1] ?? "";
    if (isStorageTempName(name) || isEditorTempName(name)) return true;
    return this.prefixes.some((prefix) => isUnderPrefix(path, prefix));
  }
}
