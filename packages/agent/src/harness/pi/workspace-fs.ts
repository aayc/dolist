/**
 * Filesystem operations for Pi's file tools, confined to the task workspace. Pi resolves the
 * model's path (including `~` and absolute paths) before calling these, so every operation checks
 * the symlink-resolved target against the workspace root.
 */
import { constants } from "node:fs";
import { access, glob, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import {
  detectSupportedImageMimeTypeFromFile,
  type EditOperations,
  type FindOperations,
  type GrepOperations,
  type LsOperations,
  type ReadOperations,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { WorkspaceGuard } from "../workspace-guard";

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
