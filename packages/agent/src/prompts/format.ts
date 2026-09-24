import { daysBetween, parseISODate, toLocalDate, truncate } from "@ddl/core";

/** "Wednesday, September 23, 2026, 6:31 PM (America/Los_Angeles, UTC-07:00)" */
export function describeNow(now: number): string {
  const date = new Date(now);
  const text = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `${text} (${zone}, ${utcOffset(date)})`;
}

function utcOffset(date: Date): string {
  const minutes = -date.getTimezoneOffset();
  const sign = minutes >= 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/** "today", "tomorrow", "in 3 days", "yesterday", "5 days ago" — relative to `now`'s local date. */
export function relativeDay(isoDate: string | null, now: number): string | null {
  if (!isoDate) return null;
  const date = parseISODate(isoDate);
  if (!date) return null;
  const diff = daysBetween(toLocalDate(new Date(now)), date);
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  if (diff === -1) return "yesterday";
  return diff > 0 ? `in ${diff} days` : `${-diff} days ago`;
}

/** JSON string literal: unambiguous quoting for model input (and parseable by the mock script). */
export function quote(text: string, max = 500): string {
  return JSON.stringify(truncate(text, max));
}

export function describeDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}
