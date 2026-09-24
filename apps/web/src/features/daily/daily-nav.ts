import {
  type DailyNoteRef,
  type DailyNoteSettings,
  dailyNotePath,
  findAdjacentDailyNote,
  type LocalDate,
  navigationAnchorDate,
  parseDailyNotePath,
} from "@ddl/core";

/** Daily note path for `date`, or null when the configured format yields an invalid path. */
export function dailyPathFor(date: LocalDate, settings: DailyNoteSettings): string | null {
  try {
    return dailyNotePath(date, settings);
  } catch {
    return null;
  }
}

export function dailyDateOf(path: string | null, settings: DailyNoteSettings): LocalDate | null {
  return path ? parseDailyNotePath(path, settings) : null;
}

/**
 * Obsidian's "previous/next daily note": the nearest EXISTING daily note before/after the active
 * daily note, or relative to today when the active note is not a daily note.
 */
export function adjacentDailyTarget(
  files: Iterable<string>,
  activePath: string | null,
  direction: -1 | 1,
  settings: DailyNoteSettings,
  now: Date = new Date(),
): DailyNoteRef | null {
  const anchor = navigationAnchorDate(activePath, settings, now);
  return findAdjacentDailyNote(files, anchor, direction, settings);
}
