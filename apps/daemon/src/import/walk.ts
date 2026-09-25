/**
 * Walks a vault folder on disk without ever leaving it: symlinks are resolved and followed only
 * to files inside the root (a symlinked folder is skipped, its target is walked where it is),
 * special files are never opened, and unreadable folders are reported instead of failing the
 * walk. One folder's entries are held at a time (sorted, so reports are deterministic).
 */
import type { Dirent } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import type { ImportSkipReason } from "@ddl/core";

export type WalkEntry =
  | { kind: "folder"; path: string }
  | {
      kind: "file";
      /** Vault-relative, `/`-separated. */
      path: string;
      /** What to read: the file itself, or the target of a symlink inside the root. */
      absolute: string;
      size: number;
      mtimeMs: number;
    }
  | { kind: "skipped"; path: string; reason: ImportSkipReason };

export interface WalkOptions {
  signal?: AbortSignal;
  /** Folders not to enter (vault-relative); they are not reported. */
  prune?: (path: string) => boolean;
}

/** `root` must be a real path (see `realpath`), so containment checks compare like with like. */
export async function* walkVault(
  root: string,
  options: WalkOptions = {},
): AsyncGenerator<WalkEntry> {
  const stack: string[] = [""];
  while (stack.length > 0) {
    options.signal?.throwIfAborted();
    const folder = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = await readdir(folder ? join(root, folder) : root, { withFileTypes: true });
    } catch {
      if (folder) yield { kind: "skipped", path: folder, reason: "unreadable" };
      else throw new Error("The folder can't be read");
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const subfolders: string[] = [];
    for (const entry of entries) {
      const path = folder ? `${folder}/${entry.name}` : entry.name;
      const absolute = join(root, path);
      if (entry.isDirectory()) {
        if (options.prune?.(path)) continue;
        subfolders.push(path);
        yield { kind: "folder", path };
      } else if (entry.isFile()) {
        const info = await lstat(absolute).catch(() => null);
        if (info?.isFile()) {
          yield { kind: "file", path, absolute, size: info.size, mtimeMs: info.mtimeMs };
        } else {
          yield { kind: "skipped", path, reason: "unreadable" };
        }
      } else if (entry.isSymbolicLink()) {
        yield await resolveLink(root, path, absolute);
      } else {
        yield { kind: "skipped", path, reason: "special_file" };
      }
    }
    // Reversed so the stack pops them in name order.
    for (let i = subfolders.length - 1; i >= 0; i--) stack.push(subfolders[i]!);
  }
}

async function resolveLink(root: string, path: string, absolute: string): Promise<WalkEntry> {
  let target: string;
  try {
    target = await realpath(absolute);
  } catch {
    return { kind: "skipped", path, reason: "unreadable" };
  }
  if (!isInside(target, root)) return { kind: "skipped", path, reason: "symlink_outside" };
  const info = await stat(target).catch(() => null);
  if (!info) return { kind: "skipped", path, reason: "unreadable" };
  if (info.isDirectory()) return { kind: "skipped", path, reason: "symlink_folder" };
  if (!info.isFile()) return { kind: "skipped", path, reason: "special_file" };
  return { kind: "file", path, absolute: target, size: info.size, mtimeMs: info.mtimeMs };
}

/** `child` is `parent` itself or somewhere below it (both absolute and normalized). */
export function isInside(child: string, parent: string): boolean {
  if (child === parent) return true;
  const prefix = parent.endsWith(sep) ? parent : `${parent}${sep}`;
  return child.startsWith(prefix);
}
