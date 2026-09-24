import {
  addDays,
  compareLocalDates,
  formatLocalDate,
  type LocalDate,
  parseDateWithFormat,
  today,
} from "./dates";
import { ensureMarkdownExtension, isMarkdownPath, normalizePath } from "./paths";

/** Mirrors Obsidian's `.obsidian/daily-notes.json` so existing vaults work unchanged. */
export interface DailyNoteSettings {
  /** Vault folder for daily notes (e.g. `Daily`). Empty string = vault root. */
  folder: string;
  /** Moment-style file name format; may contain `/` for nested folders (e.g. `YYYY/MM/YYYY-MM-DD`). */
  format: string;
  /** Template note path (with or without `.md`). Empty string = no template. */
  template: string;
}

export interface WeeklyNoteSettings {
  folder: string;
  format: string;
  template: string;
}

export const DEFAULT_DAILY_NOTE_SETTINGS: DailyNoteSettings = {
  folder: "Daily",
  format: "YYYY-MM-DD",
  template: "Templates/Daily.md",
};

export const DEFAULT_WEEKLY_NOTE_SETTINGS: WeeklyNoteSettings = {
  folder: "Weekly",
  format: "gggg-[W]ww",
  template: "Templates/Weekly.md",
};

/** Content used for a brand-new daily note when no template exists. */
export const DEFAULT_DAILY_NOTE_CONTENT = "- [ ] ";

export interface DailyNoteRef {
  path: string;
  date: LocalDate;
}

function folderPrefix(folder: string): string {
  const normalized = normalizePath(folder);
  return normalized ? `${normalized}/` : "";
}

export function dailyNotePath(date: LocalDate, settings: DailyNoteSettings): string {
  const name = formatLocalDate(date, settings.format || DEFAULT_DAILY_NOTE_SETTINGS.format);
  return normalizePath(`${folderPrefix(settings.folder)}${ensureMarkdownExtension(name)}`);
}

export function todayDailyNotePath(settings: DailyNoteSettings, now: Date = new Date()): string {
  return dailyNotePath(today(now), settings);
}

/** Returns the note's date if `path` is a daily note under the configured folder/format. */
export function parseDailyNotePath(path: string, settings: DailyNoteSettings): LocalDate | null {
  if (!isMarkdownPath(path)) return null;
  const prefix = folderPrefix(settings.folder);
  if (prefix && !path.startsWith(prefix)) return null;
  const name = path.slice(prefix.length, -".md".length);
  return parseDateWithFormat(name, settings.format || DEFAULT_DAILY_NOTE_SETTINGS.format);
}

export function isDailyNotePath(path: string, settings: DailyNoteSettings): boolean {
  return parseDailyNotePath(path, settings) !== null;
}

/** All daily notes among `paths`, sorted oldest → newest. */
export function listDailyNotes(
  paths: Iterable<string>,
  settings: DailyNoteSettings,
): DailyNoteRef[] {
  const out: DailyNoteRef[] = [];
  for (const path of paths) {
    const date = parseDailyNotePath(path, settings);
    if (date) out.push({ path, date });
  }
  return out.sort((a, b) => compareLocalDates(a.date, b.date));
}

/**
 * Obsidian's "Open previous/next daily note": the nearest EXISTING daily note strictly before
 * (direction -1) or after (+1) `from`. Returns null when there is none.
 */
export function findAdjacentDailyNote(
  paths: Iterable<string>,
  from: LocalDate,
  direction: -1 | 1,
  settings: DailyNoteSettings,
): DailyNoteRef | null {
  let best: DailyNoteRef | null = null;
  for (const path of paths) {
    const date = parseDailyNotePath(path, settings);
    if (!date) continue;
    const cmp = compareLocalDates(date, from);
    if (direction === -1 ? cmp >= 0 : cmp <= 0) continue;
    if (!best) {
      best = { path, date };
      continue;
    }
    const closer = compareLocalDates(date, best.date);
    if (direction === -1 ? closer > 0 : closer < 0) best = { path, date };
  }
  return best;
}

/** The date a daily-note navigation should be relative to: the open daily note, else today. */
export function navigationAnchorDate(
  activePath: string | null,
  settings: DailyNoteSettings,
  now: Date = new Date(),
): LocalDate {
  return (activePath && parseDailyNotePath(activePath, settings)) || today(now);
}

export function templateNotePath(settings: { template: string }): string | null {
  const t = settings.template.trim();
  return t ? ensureMarkdownExtension(normalizePath(t)) : null;
}

export function weeklyNotePath(date: LocalDate, settings: WeeklyNoteSettings): string {
  const name = formatLocalDate(date, settings.format || DEFAULT_WEEKLY_NOTE_SETTINGS.format);
  return normalizePath(`${folderPrefix(settings.folder)}${ensureMarkdownExtension(name)}`);
}

/** Dates within `[from - pastDays, from + futureDays]`, inclusive. */
export function isWithinWindow(
  date: LocalDate,
  from: LocalDate,
  pastDays: number,
  futureDays: number,
): boolean {
  return (
    compareLocalDates(date, addDays(from, -pastDays)) >= 0 &&
    compareLocalDates(date, addDays(from, futureDays)) <= 0
  );
}
