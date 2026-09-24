import { accessSync, constants } from "node:fs";
import path from "node:path";

/** Absolute path of the first executable named `name` in `dirs` (e.g. PATH entries), if any. */
export function findExecutable(name: string, dirs: readonly string[]): string | undefined {
  for (const dir of dirs) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

export function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function pathDirs(pathEnv: string | undefined): string[] {
  return (pathEnv ?? "").split(path.delimiter).filter(Boolean);
}
