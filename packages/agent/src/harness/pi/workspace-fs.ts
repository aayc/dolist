/**
 * Filesystem operations for Pi's file tools, confined to the task workspace. Pi resolves the
 * model's path (including `~` and absolute paths) before calling these, so every operation checks
 * the symlink-resolved target against the workspace root.
 */
import { constants } from "node:fs";
import {
  access,
  glob,
  mkdir,
  readdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  detectSupportedImageMimeTypeFromFile,
  type EditOperations,
  type FindOperations,
  type GrepOperations,
  type LsOperations,
  type ReadOperations,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";

export class WorkspaceAccessError extends Error {
  constructor(target: string) {
    super(`Access denied: ${target} is outside the task workspace`);
    this.name = "WorkspaceAccessError";
  }
}

export interface WorkspaceFs {
  read: ReadOperations;
  write: WriteOperations;
  edit: EditOperations;
  ls: LsOperations;
  find: FindOperations;
  grep: GrepOperations;
}

export function createWorkspaceFs(root: string): WorkspaceFs {
  const guard = new WorkspaceGuard(root);
  const exists = async (target: string) => {
    const resolved = await guard.resolve(target);
    return access(resolved).then(
      () => true,
      () => false,
    );
  };
  return {
    read: {
      readFile: async (target) => readFile(await guard.resolve(target)),
      access: async (target) => access(await guard.resolve(target), constants.R_OK),
      detectImageMimeType: async (target) =>
        detectSupportedImageMimeTypeFromFile(await guard.resolve(target)),
    },
    write: {
      writeFile: async (target, content) => writeFile(await guard.resolve(target), content, "utf8"),
      mkdir: async (dir) => {
        await mkdir(await guard.resolve(dir), { recursive: true });
      },
    },
    edit: {
      readFile: async (target) => readFile(await guard.resolve(target)),
      writeFile: async (target, content) => writeFile(await guard.resolve(target), content, "utf8"),
      access: async (target) =>
        access(await guard.resolve(target), constants.R_OK | constants.W_OK),
    },
    ls: {
      exists,
      stat: async (target) => stat(await guard.resolve(target)),
      readdir: async (target) => readdir(await guard.resolve(target)),
    },
    find: {
      exists,
      glob: async (pattern, cwd, { ignore, limit }) => {
        const base = await guard.resolve(cwd);
        const matches: string[] = [];
        for await (const match of glob(toRecursivePattern(pattern), {
          cwd: base,
          exclude: ignore,
        })) {
          matches.push(match);
          if (matches.length >= limit) break;
        }
        return matches;
      },
    },
    grep: {
      isDirectory: async (target) => (await stat(await guard.resolve(target))).isDirectory(),
      readFile: async (target) => readFile(await guard.resolve(target), "utf8"),
    },
  };
}

/** Pi's find tool (fd) matches bare patterns such as `*.ts` at any depth. */
function toRecursivePattern(pattern: string): string {
  return pattern.includes("/") ? pattern : `**/${pattern}`;
}

class WorkspaceGuard {
  private readonly root: string;
  private realRoot: string | undefined;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async resolve(target: string): Promise<string> {
    this.realRoot ??= await realpath(this.root);
    const resolved = await realpathAllowingMissing(path.resolve(this.root, target));
    if (!isInside(this.realRoot, resolved)) throw new WorkspaceAccessError(target);
    return resolved;
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

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}
