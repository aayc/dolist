import { basename, dirname, extname, formatDate } from "@ddl/core";

/**
 * Name for a conflict copy next to the original, stamped with local time:
 * `Daily/2026-09-23.md` → `Daily/2026-09-23 (conflict 2026-09-23 1830).md`. Attempts after the
 * first get a counter (`… 1830 2).md`) for conflicts within the same minute.
 */
export function conflictCopyPath(path: string, at: Date, attempt = 1): string {
  const folder = dirname(path);
  const name = basename(path);
  const ext = extname(name);
  const stemName = ext ? name.slice(0, -ext.length) : name;
  const counter = attempt > 1 ? ` ${attempt}` : "";
  const file = `${stemName} (conflict ${formatDate(at, "YYYY-MM-DD HHmm")}${counter})${ext}`;
  return folder ? `${folder}/${file}` : file;
}

const CONFLICT_COPY_NAME = / \(conflict \d{4}-\d{2}-\d{2} \d{4}(?: \d+)?\)(?:\.[^./]*)?$/;

/** True for names `conflictCopyPath` produces (on this device or another one). */
export function isConflictCopyPath(path: string): boolean {
  return CONFLICT_COPY_NAME.test(basename(path));
}
