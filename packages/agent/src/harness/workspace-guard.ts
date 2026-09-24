/**
 * Confines file access to the task workspace. Targets are resolved against the root and checked
 * after resolving symlinks (for a new file, its deepest existing ancestor), so neither `..`, an
 * absolute path nor a link can reach outside. Shared by every harness's file tools.
 */
import { realpath } from "node:fs/promises";
import path from "node:path";

export class WorkspaceAccessError extends Error {
  constructor(target: string) {
    super(`Access denied: ${target} is outside the task workspace`);
    this.name = "WorkspaceAccessError";
  }
}

export class WorkspaceGuard {
  readonly root: string;
  private realRoot: string | undefined;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /** The symlink-resolved absolute path of `target` (relative to the root); throws outside it. */
  async resolve(target: string): Promise<string> {
    const realRoot = await this.resolvedRoot();
    const resolved = await realpathAllowingMissing(path.resolve(this.root, target));
    if (!isInside(realRoot, resolved)) throw new WorkspaceAccessError(target);
    return resolved;
  }

  /** The root with symlinks resolved (e.g. `/private/var/…` for `/var/…` on macOS). */
  async resolvedRoot(): Promise<string> {
    this.realRoot ??= await realpath(this.root);
    return this.realRoot;
  }
}

/** Real path of `target`, resolving the deepest existing ancestor when the target is new. */
async function realpathAllowingMissing(target: string): Promise<string> {
  const missing: string[] = [];
  let current = target;
  for (;;) {
    try {
      return path.join(await realpath(current), ...missing.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = path.dirname(current);
      if (parent === current) return target;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

export function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}
