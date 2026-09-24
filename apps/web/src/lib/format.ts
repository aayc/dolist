import { formatLocalDate, type LocalDate, today, toLocalDate } from "@ddl/core";

/** Daily note title: "Thursday, September 24", plus ", 2025" when it isn't the current year. */
export function dailyNoteTitle(date: LocalDate, now: LocalDate = today()): string {
  return formatLocalDate(date, date.year === now.year ? "dddd, MMMM D" : "dddd, MMMM D, YYYY");
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dayTimeFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function isSameLocalDay(a: number, b: number): boolean {
  const x = toLocalDate(new Date(a));
  const y = toLocalDate(new Date(b));
  return x.year === y.year && x.month === y.month && x.day === y.day;
}

/** "3:42 PM" today, "Sep 22, 3:42 PM" otherwise. */
export function formatTimestamp(ts: number, now: number = Date.now()): string {
  return isSameLocalDay(ts, now) ? timeFormat.format(ts) : dayTimeFormat.format(ts);
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

const WORD_RE = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

export function countWords(text: string): number {
  let count = 0;
  WORD_RE.lastIndex = 0;
  while (WORD_RE.exec(text) !== null) count++;
  return count;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
