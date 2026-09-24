import { createHash } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { ExecutionError } from "../errors";
import type { Workspace } from "../types";

const MAX_NAME_LENGTH = 80;

/**
 * Filesystem-safe directory name for a workspace key. Keys that had to change get a short hash of
 * the original, so distinct keys never share a directory (lowercased: macOS volumes are usually
 * case-insensitive).
 */
export function workspaceDirName(key: string): string {
  const cleaned = key
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, MAX_NAME_LENGTH);
  if (cleaned === key && cleaned.length > 0) return cleaned;
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 8);
  return cleaned ? `${cleaned}-${hash}` : `workspace-${hash}`;
}

/** Creates (or reuses) `<home>/workspaces/<name>` with owner-only permissions. */
export async function prepareLocalWorkspace(home: string, key: string): Promise<Workspace> {
  const root = resolve(home, "workspaces");
  const dir = join(root, workspaceDirName(key));
  const rel = relative(root, dir);
  if (!rel || rel.startsWith("..")) {
    throw new ExecutionError(`Refusing workspace outside ${root}`);
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  await chmod(dir, 0o700);
  return { key, dir };
}
